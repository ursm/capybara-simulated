// A realm's timers (HTML "map of active timers", §8.6) and the tasks the platform queues on the same list: each its
// handler — a function, or a string run as a script — with its arguments, when it falls due on the agent's virtual
// clock, and the period it repeats at. They run in the order they fall due, and those due at once in the order they
// were scheduled — an interval keeps its place among them as it repeats. The bindings run each as its turn comes
// (timers.js `runTask`), moving the clock (`EventLoop::clock`) to when it falls due.
//
// The lists are the realms', the event loop running them the agent's (`EventLoop`): HTML gives a similar-origin window
// agent ONE event loop, which every window realm of it queues its tasks on — the page's, its frames' and theirs, and the
// windows it opened in this isolate. A step takes the task due first of all of theirs (`agentNext`), and those due at
// once in the order they were queued, whichever realm queued them: the sequence is the agent's (`EventLoop::seq`).
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
    turn: u8,
    seq: u64,
    handler: v8::Global<v8::Value>,
    args: Option<v8::Global<v8::Value>>,
    // The timeout a repeating timer is scheduled again with (HTML: the timer initialization steps run again).
    period: Option<f64>,
    // Its task's timer nesting level (HTML §8.6): one more than that of the timer task it was scheduled in, 0 outside one.
    nesting: u32,
    // The time on its realm's clock it runs no earlier than — the time it was set at and its timeout, its realm's `Date`
    // then — and that timeout, a repeating one's next run counted from the time it runs (`timerNext`). Due on the virtual
    // clock, which the realm's clock may stand ahead of while it is held (agent_clock.rs `clockAtLeast`) — a worker's
    // whose scripts ran longer than its window's step, a page a busy worker's answer brought on — a `setTimeout(…, 50)` set
    // then fell due as the virtual clock reached it, 50 ms behind: it runs with its realm's clock held on to that time,
    // its virtual clock and its due times as they stand (HTML timer initialization). Where another agent's time held the
    // clock, it falls due that much later on the virtual clock instead (agent_clock.rs `Read::lead`); where a worker's own
    // scripts did, not: a service worker's `setTimeout(…, 2000)` set as its 1 s computation ended falls due 2 s later on
    // the virtual clock and runs with its `Date` 3 s on — its answer, which carries that time, landing on the page 3 s on
    // all the same (sw-client.js). None for no timeout, nor a crossing queue's turn: due with a timer, not on to its delay
    // past a clock held ahead as it runs, which moved the realm's time on by the wait.
    not_early: Option<(f64, f64)>,
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
    // The keys in the order they run: by when they are due, then by their turn (`AHEAD` before `IN_TURN`), then by when
    // they were scheduled.
    order: BTreeSet<(Due, u8, u64, i64)>,
    last_id: i64,
    // Its animation frame callbacks (HTML "map of animation frame callbacks"), by the id `requestAnimationFrame` gave
    // each, in the order they were requested — and those of the frame being run, taken as it began (one requested by
    // a callback of it runs in the next), each as its turn comes, which a cancel by an earlier one still reaches.
    frames: std::collections::VecDeque<(u32, v8::Global<v8::Value>)>,
    running: std::collections::VecDeque<(u32, v8::Global<v8::Value>)>,
    last_frame: u32,
    // The repeating timer whose task is running now, with when it ran: scheduled again as its task ends (`end_task`),
    // after whatever its handler scheduled.
    repeating: Option<(i64, f64)>,
    // Its idle request callbacks (requestIdleCallback §5.2), by the handle each was given: those requested since the last
    // idle period began (its "list of idle request callbacks"), those an idle period made runnable and has yet to run
    // ("list of runnable idle callbacks"), each in order — and when the idle period running began.
    idle: std::collections::VecDeque<IdleRequest>,
    runnable: std::collections::VecDeque<IdleRequest>,
    last_idle: u32,
    idle_began: f64,
    // Whether a task of the realm's is running (`timerNext` to `timerTaskEnd`): one that disposes the realm's own context
    // — a frame's script removing its own iframe — leaves its networking tasks to run on to the end of the step it is
    // in, the request it sent failing as the step runs on (WPT xhr/open-url-multi-window-4), the list going as it ends
    // (`EventLoop::steps`). A frame another realm's task removes runs nothing more, as in a browser.
    in_task: bool,
    // …and the platform tasks of a source of their own (`Source`), by key: none, most of them.
    sources: HashMap<i64, Source>,
}

// The source of a platform task the event loop treats apart (`timerAdd`'s `source`): a crossing queue's turn (timers.js
// `runCrossings`), which another realm's turn does not wait behind; a request's (xhr.js), which runs on with the step
// its own realm's task disposed its context in — a message it posted to itself does not, its document no longer fully
// active (Chrome and Firefox: a frame posting to itself and removing itself hears nothing); or a navigation's (`BEHIND`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Turn,
    Network,
    Navigation,
}
impl Source {
    fn of(code: i32) -> Option<Source> {
        match code {
            1 => Some(Source::Turn),
            2 => Some(Source::Network),
            3 => Some(Source::Navigation),
            _ => None,
        }
    }
}

// The agent's event loop (HTML §8.1.7): its virtual clock — the time it has reached, in milliseconds, which its steps
// move (`move_clock`) and every window realm of the agent reads and schedules on (agent_clock.rs reads it for
// `Date` and `performance.now()`), one clock where each realm had one of its own: a frame's ran a step behind its
// parent's and its timers fell due a step late, in a batch after the parent's — and the sequence its tasks were queued
// in, across the realms' lists, which orders those due at once. And, for each step under way (`agentStep`), the realms
// whose contexts a task of their own disposed during it, which run on to its end (`Timers::in_task`).
#[derive(Default)]
pub(crate) struct EventLoop {
    pub(crate) clock: f64,
    // The agent's `Date` scale — what its first document's `Date` read at clock 0 and no script time, which runs on with
    // the clock and the script time whatever document comes after (agent_clock.rs `agentShift`): the time every message
    // that leaves the agent carries.
    pub(crate) agent_epoch: Option<f64>,
    seq: u64,
    steps: Vec<Vec<i32>>,
    // The nesting level of the timer task running now — none where the task running is none of a timer's (a platform
    // task, an animation frame, a script the host runs) — which a timer it schedules nests in (`timerNext`,
    // `timerTaskEnd`): the event loop's, whichever realm's timer it is and whichever realm's `setTimeout` is called
    // (HTML timer initialization steps 5: "the surrounding agent's event loop's currently running task"; Firefox — a
    // chain alternating the page's and a frame's `setTimeout` clamps to 4 ms; Chrome's per realm does not).
    task_nesting: Option<u32>,
    // The task due first of all its realms' (`agent_first`), as last found — none until asked again after its lists or its
    // realms change (`changed`): a pick reads it twice, and with forty frames the walk over them was a fifth of a step.
    first: std::cell::Cell<Option<Option<((Due, u8, u64, i64), i32)>>>,
    // The settle generation of each realm as last read (`agentSettleGen`), and those of the realms since gone from it, or
    // begun anew, summed: what a realm's leaving adds rather than takes from the event loop's.
    settle_seen: HashMap<i32, u32>,
    settle_retired: u64,
    // When its last rendering update ran (`renderBegins`) — none since its main realm's context, which its steps run
    // in, was made (`install`).
    rendered: Option<f64>,
    // The host's function told of each move of the clock (`move_clock`), where workers follow the window's clock
    // (`clockFollow`) — none since its main realm's context was made, as for `rendered`.
    followed: Option<v8::Global<v8::Function>>,
}

impl EventLoop {
    // A realm's list, or the realms, changed: the task due first is to be found again.
    pub(crate) fn changed(&self) {
        self.first.set(None);
    }
    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
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

// A task's turn among those due at once — HTML leaves the choice among task sources to the event loop, so this is how it
// chooses: in the order scheduled (`IN_TURN`) — every timer, every message, most tasks — or ahead of them (`AHEAD`): a
// one-shot task of "the end" of a window's own document, queued once: its DOMContentLoaded, and its load where nothing
// delays it. Measured 2026-11-01 (Chrome 156, Firefox 159): both fire DOMContentLoaded before a zero timer and a message
// the parse queued where the parse ends at once, and the load that nothing delays before such a message (Chrome before
// the timer too, `dcl, load, msg, t0`; Firefox after it); where the parse waits on a slow external script Chrome runs the
// timer and the message first (`t0, msg, dcl`). No turn starves: an `AHEAD` task is one of a document's two, never
// queued again by what runs. Or behind them (`BEHIND`), whichever realm's they are and whenever they were queued: what
// a frame's navigation goes on with once the steps HTML "navigate" runs at once are done — its document asked and left,
// the response in — which HTML runs in parallel with the event loop, a network's time away from the task that began it.
// A zero timer queued after the `src` set comes first, and the chain it starts, until its nesting clamp moves it past
// this instant (`old-t30 P0 old-pagehide`; Chrome `c0 … c4` before the pagehide, Firefox `c0 c1 c2`). The clock moving on
// ends the wait: a task due earlier runs first, so none starves.
pub(crate) const AHEAD: u8 = 0;
const IN_TURN: u8 = 1;
const BEHIND: u8 = 2;

impl Timers {
    // Its networking tasks kept, the rest gone: its page's timers, its other platform tasks, animation frame and idle
    // callbacks.
    fn keep_network_tasks(&mut self) {
        let sources = std::mem::take(&mut self.sources);
        self.sources = sources.into_iter().filter(|&(_, s)| s == Source::Network).collect();
        let kept = &self.sources;
        self.order.retain(|&(.., key)| kept.contains_key(&key));
        self.by_key.retain(|key, _| kept.contains_key(key));
        self.frames.clear();
        self.running.clear();
        self.idle.clear();
        self.runnable.clear();
    }
    fn add(&mut self, key: i64, timer: Timer) {
        self.order.insert((Due(timer.due), timer.turn, timer.seq, key));
        self.by_key.insert(key, timer);
    }
    fn clear(&mut self, key: i64) -> bool {
        let Some(t) = self.by_key.remove(&key) else { return false };
        self.sources.remove(&key);
        self.order.remove(&(Due(t.due), t.turn, t.seq, key));
        true
    }
    // HTML §8.6 timer task step 7: a repeating timer, its handler run, runs the timer initialization steps again — due
    // its timeout after it ran, clamped at its nesting level and a level deeper, ordered after every timer scheduled
    // before now, its handler's own — unless the handler cleared it. Its task over, what runs next is no timer task.
    // (…`seq` the place in the event loop's sequence it is queued at again, `RealmArena::end_timer_task`)
    fn end_task(&mut self, seq: u64) {
        self.in_task = false;
        let Some((key, run)) = self.repeating.take() else { return };
        let Some(t) = self.by_key.get_mut(&key) else { return };
        let Some(timeout) = t.period else { return };
        t.due = run + clamped(timeout, t.nesting);
        t.nesting += 1;
        t.seq = seq;
        self.order.insert((Due(t.due), t.turn, seq, key));
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
    // animation frame callback waits for the rendering update (`renders`, any document's of the event loop: HTML "has
    // pending renders" asks each same-loop window) — one requested during it too — and never past the event
    // loop's task due first, `next` (any realm's of the agent: "the event loop's next timer"). (Each a span less what has
    // gone of it, so a period just begun has its cap exactly.)
    fn idle_remaining(&self, now: f64, next: Option<f64>, renders: bool) -> f64 {
        let gone = now - self.idle_began;
        let cap = if renders { FRAME_INTERVAL_MS } else { IDLE_PERIOD_MAX_MS };
        let timer = next.map_or(f64::INFINITY, |due| due - now);
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
    // The mark of the tasks queued on the event loop now: the timers and platform tasks scheduled so far, of every realm
    // of the agent, and its clock (`queued_by`).
    pub(crate) fn task_mark(&self) -> (u64, f64) {
        (self.event_loop.seq, self.event_loop.clock)
    }
    // …and whether some of them are still to run: scheduled by the mark and due by its clock — the occurrences queued
    // then, a repeating timer's later ones (scheduled again, past the mark) none: the mark's number, which the host runs
    // the event loop's tasks by (`__csimRunQueued`). What a reload's history step runs before it unloads the document
    // (HTML "apply the history step" step 12 queues its unloading as a global task on the document's window, after those
    // queued on its event loop before it — a `javascript:` URL's, a frame's timer due).
    pub(crate) fn queued_by(&mut self, mark: (u64, f64)) -> Option<u64> {
        (self.queued_count(mark) > 0).then_some(mark.0)
    }
    // …how many of them are left — what a run of them is capped at — and whether the event loop's next task is one of
    // them — where it is one queued after the mark (its turn ahead of theirs: an `AHEAD` one), the run stops, the rest
    // left to the event loop's own steps.
    fn queued_count(&mut self, (mark, clock): (u64, f64)) -> u32 {
        let mut count = 0;
        for realm in self.event_loop_realms() {
            if let Some(t) = self.timers_of(realm) {
                count += t.order.iter().take_while(|&&(Due(due), ..)| due <= clock).filter(|&&(_, _, seq, _)| seq <= mark).count() as u32;
            }
        }
        count
    }
    // What is left now of realm `cid`'s idle period (`Timers::idle_remaining`), against the event loop's next task.
    // (…"has pending renders": an animation frame callback of any document of the event loop's)
    fn idle_remaining(&mut self, cid: i32) -> f64 {
        let next = self.agent_first().map(|((Due(due), ..), _)| due);
        let now = self.event_loop.clock;
        let renders = self.event_loop_realms().into_iter().any(|r| self.realm_state(r).is_some_and(|s| !s.timers.frames.is_empty()));
        self.timers_of(cid).map_or(0.0, |t| t.idle_remaining(now, next, renders))
    }
    fn next_queued_by(&mut self, (mark, clock): (u64, f64)) -> bool {
        self.agent_first().is_some_and(|((Due(due), _, seq, _), _)| due <= clock && seq <= mark)
    }
    // The realms whose tasks the event loop runs: the agent's (navigables.rs `agent_realms_unordered`), and those whose
    // contexts a task of their own disposed during the step under way, which run on to its end (`Timers::in_task`).
    fn event_loop_realms(&self) -> Vec<i32> {
        let mut realms = Vec::new();
        self.each_event_loop_realm(|r| realms.push(r));
        realms
    }
    // …each in turn, none collected.
    fn each_event_loop_realm(&self, mut visit: impl FnMut(i32)) {
        for &realm in self.agent_realms_unordered() {
            visit(realm);
        }
        if let Some(step) = self.event_loop.steps.last() {
            step.iter().filter(|&&r| !self.is_dropped(r)).for_each(|&r| visit(r));
        }
    }
    // …whether that is the page's alone — the common page's, whose event loop is asked of no other realm.
    fn page_alone(&self) -> bool {
        self.agent_realms_alone() && self.event_loop.steps.last().is_none_or(|step| step.is_empty())
    }
    // The event loop's task due first and its realm: each realm's list in its own order — by when a task falls due, its
    // turn, and when it was queued — and the realms' first tasks by when they fall due and were queued. A turn ahead is
    // its document's own (`AHEAD`: the end of its parse), not one over another document's tasks: a `javascript:` URL a
    // link in the page navigated its frame to, queued in the frame before the page's load, runs before it (WPT
    // navigating-across-documents/013, 015: the load comes after it, queued after it).
    fn agent_first(&self) -> Option<((Due, u8, u64, i64), i32)> {
        if let Some(first) = self.event_loop.first.get() {
            return first;
        }
        let first = self.agent_first_by(|t| t.order.first().copied());
        self.event_loop.first.set(Some(first));
        first
    }
    // …none of a crossing queue's turns (`Source::Turn`).
    fn agent_first_task(&self) -> Option<((Due, u8, u64, i64), i32)> {
        self.agent_first_by(|t| t.order.iter().find(|&&(.., key)| t.sources.get(&key) != Some(&Source::Turn)).copied())
    }
    fn agent_first_by(&self, first_of: impl Fn(&Timers) -> Option<(Due, u8, u64, i64)>) -> Option<((Due, u8, u64, i64), i32)> {
        let head = |realm: i32| self.realm_state(realm).and_then(|s| first_of(&s.timers));
        if self.page_alone() {
            return head(0).map(|h| (h, 0));
        }
        let mut first: Option<((Due, u8, u64, i64), i32)> = None;
        self.each_event_loop_realm(|realm| {
            let Some(h) = head(realm) else { return };
            if first.is_none_or(|(f, _)| (h.0, h.1 == BEHIND, h.2) < (f.0, f.1 == BEHIND, f.2)) {
                first = Some((h, realm));
            }
        });
        first
    }
    // Realm `cid`'s timer task over: a repeating one queued again (`Timers::end_task`).
    fn end_timer_task(&mut self, cid: i32) {
        self.event_loop.changed();
        self.event_loop.task_nesting = None;
        let rearms = self.timers_of(cid).is_some_and(|t| t.repeating.is_some());
        let seq = if rearms { self.event_loop.next_seq() } else { 0 };
        if let Some(timers) = self.timers_of(cid) {
            timers.end_task(seq);
        }
    }
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
        self.event_loop.changed();
        if let Some(timers) = self.timers_of(cid) {
            *timers = Timers::default();
        }
        self.task_keys.realms.retain(|_, &mut c| c != cid);
    }
    // …or its context disposed: gone now, or — by a task of its own — its requests' tasks as the step under way ends
    // (`Timers::in_task`), the rest gone now (a frame's interval, and a message it posted itself, ran on to the end of
    // the step its own script removed the frame in, where Chrome and Firefox run neither) — and none taken after.
    pub(crate) fn discard_timers(&mut self, cid: i32) {
        self.event_loop.changed();
        self.task_keys.discarded.insert(cid);
        let runs_on = self.timers_of(cid).is_some_and(|t| t.in_task) && self.event_loop.steps.last_mut().is_some_and(|step| {
            if !step.contains(&cid) {
                step.push(cid);
            }
            true
        });
        if !runs_on {
            self.drop_timers(cid);
        } else if let Some(timers) = self.timers_of(cid) {
            timers.keep_network_tasks();
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
    // Whether realm `cid` takes a timer: not one dropped, nor one disposed, but one running on to the step's end.
    fn takes_timers(&mut self, cid: i32) -> bool {
        if self.is_dropped(cid) {
            return false;
        }
        !self.task_keys.discarded.contains(&cid) || self.event_loop.steps.last().is_some_and(|step| step.contains(&cid))
    }
}

// (…and, as the agent's main realm begins anew, the event loop's steps run in a new context, with no rendering update
// behind them: `EventLoop::rendered`)
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if context_id == 0 {
        let event_loop = &mut dom(scope).arena.event_loop;
        event_loop.rendered = None;
        event_loop.followed = None;
    }
    register(scope, ns, "clockNow", clock_now, context_id);
    register(scope, ns, "clockTo", clock_to, context_id);
    register(scope, ns, "clockBy", clock_by, context_id);
    register(scope, ns, "clockFollow", clock_follow, context_id);
    register(scope, ns, "clockFollowed", clock_followed, context_id);
    register(scope, ns, "timerAdd", timer_add, context_id);
    register(scope, ns, "timerClear", timer_clear, context_id);
    register(scope, ns, "timerNext", timer_next, context_id);
    register(scope, ns, "realmPending", realm_pending, context_id);
    register(scope, ns, "timersQueuedBy", timers_queued_by, context_id);
    register(scope, ns, "timerNextQueuedBy", timer_next_queued_by, context_id);
    register(scope, ns, "nextTimerDelay", next_timer_delay, context_id);
    register(scope, ns, "timerTaskEnd", timer_task_end, context_id);
    register(scope, ns, "agentStep", agent_step, context_id);
    register(scope, ns, "agentNext", agent_next, context_id);
    register(scope, ns, "crossingAdd", crossing_add, context_id);
    register(scope, ns, "crossingNext", crossing_next, context_id);
    register(scope, ns, "crossingTurnDelay", crossing_turn_delay, context_id);
    register(scope, ns, "swAsked", sw_asked, context_id);
    register(scope, ns, "swAnswered", sw_answered, context_id);
    register(scope, ns, "agentFramesOwed", agent_frames_owed, context_id);
    register(scope, ns, "agentReady", agent_ready, context_id);
    register(scope, ns, "renderBegins", render_begins, context_id);
    register(scope, ns, "stepRenderOwed", step_render_owed, context_id);
    register(scope, ns, "stepRenderAt", step_render_at, context_id);
    register(scope, ns, "stepRendered", step_rendered, context_id);
    register(scope, ns, "stepAnimFrameAt", step_anim_frame_at, context_id);
    register(scope, ns, "stepPin", step_pin, context_id);
    register(scope, ns, "agentRealms", agent_realms, context_id);
    register(scope, ns, "agentSettleGen", agent_settle_gen, context_id);
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
            let due = arena.event_loop.clock + timeout;
            let seq = arena.event_loop.next_seq();
            arena.event_loop.changed();
            let timer = Timer { due, turn: IN_TURN, seq, handler: timed_out, args: Some(list), period: None, nesting: 0, not_early: None };
            arena.enter(cid).timers.add(key, timer);
            key
        });
        arena.enter(cid).timers.idle.push_back(IdleRequest { handle, callback, timeout });
    }
    rv.set_uint32(handle);
}
// An idle request callback taken from its list — run, cancelled or timed out — its timeout's task gone with it.
fn taken_idle(arena: &mut RealmArena, cid: i32, request: IdleRequest) -> v8::Global<v8::Value> {
    if let Some(key) = request.timeout {
        arena.event_loop.changed();
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
    let arena = &mut dom(scope).arena;
    let now = arena.event_loop.clock;
    rv.set_bool(arena.enter(cid).timers.begin_idle(now));
}
// __dom.idleNext() -> [handle, callback]: the idle period's next runnable callback, taken — undefined once there is none,
// or its deadline has passed (§5.5 "invoke idle callbacks": the rest wait for the next).
fn idle_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    if arena.idle_remaining(cid) <= 0.0 {
        return;
    }
    let Some(request) = arena.enter(cid).timers.runnable.pop_front() else { return };
    let handle = request.handle;
    let callback = taken_idle(arena, cid, request);
    let handle = v8::Integer::new_from_unsigned(scope, handle).into();
    let callback = v8::Local::new(scope, callback);
    rv.set(v8::Array::new_with_elements(scope, &[handle, callback]).into());
}
// __dom.idleRemaining() -> what is left of the calling realm's idle period, as it stands (`Timers::idle_remaining`).
fn idle_remaining(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(dom(scope).arena.idle_remaining(cid));
}

// __dom.agentStep(begins) — a step of the event loop begins, or ends: a realm whose context a task of its own disposed
// during it runs on with it to here, and takes its timers with it as it ends (`discard_timers`).
fn agent_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &mut dom(scope).arena;
    arena.event_loop.changed();
    if args.get(0).is_true() {
        arena.event_loop.steps.push(Vec::new());
        return;
    }
    let Some(realms) = arena.event_loop.steps.pop() else { return };
    for realm in realms {
        if arena.task_keys.discarded.contains(&realm) && !arena.event_loop.steps.iter().any(|step| step.contains(&realm)) {
            arena.drop_timers(realm);
        }
    }
}

// __dom.clockNow() -> the time the event loop's clock reads.
fn clock_now(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(dom(scope).arena.event_loop.clock);
}

// The event loop's clock on to `to`, where it stands before it — whether it moved — and the host told, where the window's
// workers follow its clock (`EventLoop::followed`): a task in the middle of a step that posts to a worker posts at its
// own time, and the worker must not read the time the step began at (Browser#run_worker). Every move of the clock is
// this one, whichever op makes it.
pub(crate) fn move_clock(scope: &mut v8::PinScope<'_, '_>, to: f64) -> bool {
    let event_loop = &mut dom(scope).arena.event_loop;
    if !(to > event_loop.clock) || !to.is_finite() {
        return false;
    }
    event_loop.clock = to;
    let tell = event_loop.followed.clone();
    if let Some(tell) = tell.map(|f| v8::Local::new(scope, f)) {
        let receiver = v8::undefined(scope).into();
        let at = v8::Number::new(scope, to).into();
        tell.call(scope, receiver, &[at]);
    }
    true
}

// __dom.clockTo(time) — the event loop's clock on to `time`, where it stands before it (`move_clock`): the virtual time a
// worker's answer took while the window waited on it in place (Browser#await_worker_reply), which passed for the window
// too.
fn clock_to(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(time) = args.get(0).number_value(scope) else { return };
    move_clock(scope, time);
}

// __dom.clockBy(ms) — the event loop's clock on by `ms`: a script's that waited that long inside a sync XHR, for a
// worker's answer or a server's modeled delay — which `Date` and `performance.now()` show as they advance by `ms`, the
// real time the wait took none of their script time (agent_clock.rs `agentWait`).
fn clock_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let ms = args.get(0).number_value(scope).unwrap_or(0.0);
    if ms > 0.0 {
        let to = dom(scope).arena.event_loop.clock + ms;
        move_clock(scope, to);
    }
}

// __dom.clockFollow(tell) — the window's workers follow its clock from now (a worker, a service worker or a remote port
// made, in any realm of the agent): each move of it is told to the host through `tell` (`move_clock`).
fn clock_follow(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(tell) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let tell = v8::Global::new(scope, tell);
    dom(scope).arena.event_loop.followed = Some(tell);
}

// __dom.clockFollowed() -> whether the window's workers follow its clock (`clockFollow`).
fn clock_followed(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(dom(scope).arena.event_loop.followed.is_some());
}

// __dom.timerAdd(handler, args, timeout, repeats, task, ahead, source) -> its key: a timer of the calling realm's,
// falling due `timeout` ms after now on the event loop's clock — never, for one that is no finite time — and, `repeats`,
// again that long after each run: a page's (`task` false: a positive id), nested in the timer task running and clamped
// by its nesting level, or one the platform queues (`task` true: a negative key), which neither nests nor is clamped —
// and, `ahead`, runs ahead of those due with it (`AHEAD`; a page's timer never). A page's, or a platform task of a
// timeout — an XHR's `timeout`, an AbortSignal's — falls due later the first time by what the realm's `Date` stands ahead
// of this clock by (agent_clock.rs `Read::lead`), which its timeout is counted from, and runs no earlier on its realm's
// clock than its timeout after it was set (`Timer::not_early`). A platform task of a source the event loop treats apart
// is kept as one (`source`: 1 a crossing queue's turn, which neither, 2 a request's, 3 a navigation's, `BEHIND` those due
// with it — `Source`).
fn timer_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let handler = v8::Global::new(scope, args.get(0));
    let list = args.get(1);
    let list = (!list.is_null_or_undefined()).then(|| v8::Global::new(scope, list));
    let timeout = args.get(2).number_value(scope).unwrap_or(0.0);
    let repeats = args.get(3).is_true();
    let task = args.get(4).is_true();
    let source = if task { args.get(6).int32_value(scope).and_then(Source::of) } else { None };
    let turn = match source {
        Some(Source::Navigation) => BEHIND,
        _ if task && args.get(5).is_true() => AHEAD,
        _ => IN_TURN,
    };
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let (not_early, lead) = if (timeout > 0.0 && source != Some(Source::Turn)) || !task {
        let (at, lead) = crate::agent_clock::timer_times(d, cid, timeout);
        ((timeout > 0.0).then_some((at, timeout)), lead)
    } else {
        (None, 0.0)
    };
    let arena = &mut d.arena;
    let now = arena.event_loop.clock;
    let takes = arena.takes_timers(cid);
    let nesting = if task { 0 } else { arena.event_loop.task_nesting.unwrap_or(0) };
    let timeout = if task { timeout } else { clamped(timeout, nesting) };
    let due = Some(now + timeout + lead).filter(|d| d.is_finite()).unwrap_or(f64::MAX);
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
        let seq = arena.event_loop.next_seq();
        arena.event_loop.changed();
        let timers = &mut arena.enter(cid).timers;
        let nesting = if task { 0 } else { nesting + 1 };
        timers.add(key, Timer { due, turn, seq, handler, args: list, period, nesting, not_early });
        if let Some(source) = source {
            timers.sources.insert(key, source);
        }
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
    arena.event_loop.changed();
    let cleared = cid.and_then(|cid| arena.timers_of(cid)).is_some_and(|timers| timers.clear(key));
    rv.set_bool(cleared);
}

// __dom.timerTaskEnd() — the task the calling realm's last `timerNext` took has run: what runs next — its microtasks,
// each the running task of its own — is no timer task until another is taken.
fn timer_task_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    dom(scope).arena.end_timer_task(cid);
}

// __dom.timerNext(limit) -> `[handler, args, page]`: the calling realm's next timer, where it falls due by `limit` — taken
// from the list, one that repeats to be scheduled again as its task ends (`timerTaskEnd`); undefined for none. The clock
// is moved on to when it falls due (`move_clock`), and its realm's clock held on to the time it runs no earlier than
// (`Timer::not_early`) — a repeating one's next counted from now. A page's (`page`) is the timer task
// running from here, a platform task none. (A task a terminated handler never ended is ended here first.)
fn timer_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let arena = &mut d.arena;
    let now = arena.event_loop.clock;
    arena.end_timer_task(cid);
    let timers = &mut arena.enter(cid).timers;
    let Some(&(Due(due), turn, seq, key)) = timers.order.first().filter(|&&(Due(due), ..)| due <= limit) else { return };
    timers.order.remove(&(Due(due), turn, seq, key));
    timers.sources.remove(&key);
    timers.in_task = true;
    let run = due.max(now);
    let repeats = timers.by_key.get(&key).and_then(|t| t.period);
    let (handler, list, nesting, not_early) = match repeats {
        Some(_) => {
            let Some(t) = timers.by_key.get(&key) else { return };
            timers.repeating = Some((key, run));
            (t.handler.clone(), t.args.clone(), Some(t.nesting), t.not_early)
        }
        None => {
            let Some(t) = timers.by_key.remove(&key) else { return };
            arena.task_keys.realms.remove(&key);
            (t.handler, t.args, (key > 0).then_some(t.nesting), t.not_early)
        }
    };
    arena.event_loop.task_nesting = nesting;
    move_clock(scope, due);
    let d = dom(scope);
    if let Some((at, timeout)) = not_early {
        crate::agent_clock::hold(d, cid, at);
        if repeats.is_some() {
            let next = crate::agent_clock::timer_times(d, cid, timeout).0;
            if let Some(t) = d.arena.timers_of(cid).and_then(|timers| timers.by_key.get_mut(&key)) {
                t.not_early = Some((next, timeout));
            }
        }
    }
    let handler = v8::Local::new(scope, handler);
    let list = list.map_or_else(|| v8::undefined(scope).into(), |l| v8::Local::new(scope, l));
    let page = v8::Boolean::new(scope, key > 0).into();
    rv.set(v8::Array::new_with_elements(scope, &[handler, list, page]).into());
}

// __dom.realmPending(realm, subtree) -> whether realm `realm` (the calling one, for null) has work its event loop is to
// run — a timer, an animation frame or idle callback, an observation owed at its next rendering update
// (`GEN_OBSERVATIONS`), a CSS image owed its fetch there (rendered.rs `CssImages::owed`), an autofocus candidate a flush
// is owed for, an animation that needs frames (`frames_due`) — and, with `subtree`, any realm of its child navigables
// does, theirs too: what keeps the driver stepping the page.
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
            || st.css_images.borrow().owed()
    });
    if own || arena.autofocus.pending_in(arena, realm) || crate::animation_ops::frames_due(scope, realm) {
        return true;
    }
    subtree && dom(scope).arena.stepped_realms(realm).into_iter().any(|child| pending(scope, child, true))
}

// __dom.nextTimerDelay() -> the time, on its clock, to the next work the calling realm's event loop has due — 0 for an
// animation frame callback requested, else its earliest timer's, or a frame an animation its style engine runs is due —
// and its frames', whose tasks its event loop runs too (`agentNext`), the earliest of them; -1 for none. What the host's
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
        if let Some(&(Due(due), ..)) = state.timers.order.first() {
            min = min.min(due - arena.event_loop.clock);
        }
        pending.extend(arena.stepped_realms(realm));
        if let Some(delay) = crate::animation_ops::next_frame_delay_of(scope, realm) {
            min = min.min(delay);
        }
    }
    rv.set_double(if min == f64::INFINITY { -1.0 } else { min.max(0.0) });
}

// __dom.timersQueuedBy(mark) -> how many tasks of the event loop's queued by `mark` (`task_mark`'s number) are due now,
// still to run; __dom.timerNextQueuedBy(mark) -> whether its next task is one of them (`queued_count`).
fn timers_queued_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mark = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
    let arena = &mut dom(scope).arena;
    let clock = arena.event_loop.clock;
    rv.set_uint32(arena.queued_count((mark, clock)));
}
fn timer_next_queued_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mark = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
    let arena = &mut dom(scope).arena;
    let clock = arena.event_loop.clock;
    rv.set_bool(arena.next_queued_by((mark, clock)));
}

// __dom.agentNext(limit) -> the realm whose task the event loop runs next, where one falls due by `limit` — the task due
// first of all its realms' (`agent_first`), which that realm's `timerNext` takes, the clock moved on to when it falls due
// — or -1 for none.
fn agent_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let Some(((Due(due), ..), realm)) = dom(scope).arena.agent_first().filter(|&((Due(due), ..), _)| due <= limit) else {
        return rv.set_int32(-1);
    };
    move_clock(scope, due);
    rv.set_int32(realm);
}

// What another agent sent a realm — a message on any channel, a service worker's answer — run at the time it was sent at
// (its sender's clock as it sent it, before any offset), among the realm's own work, in ONE queue of the realm's, by that
// time: each runs once no task of its event loop falls due on its virtual clock before it — any realm's of the agent: the
// message's task is queued on the receiver's event loop (HTML "queue a global task" on the posted message task source of
// the target's global), which runs the tasks of the page and its frames in the order they fall due, a frame's 40 ms timer
// before the page's message from a worker sent at 45 — judged against the realm's own time (agent_clock.rs `own_now`), no
// lift an earlier message put on its clock — those running first, at their own times, the queue waiting behind them one
// timer's due at a time; then at once, its clock held at that time (`clockAtLeast`) until its virtual clock passes it. A
// worker's 1 s computation answered the page ahead of the page's `setTimeout(…, 300)` and `(…, 600)`, its `Date` lifted
// by it for good; and with two senders waiting, each saw the other's turn in the queue as a timer of the page's, or the
// clock the other had lifted, and ran ahead of the page's timers. The virtual clock moves only to the realm's own due
// times, the same every run: what the senders' scripts took, real time, moves no task of the realm's. Per key (a
// worker's, a port's, a channel's, a request's) in the order they came: one is run no earlier than one of its key before
// it.
// (…each by the number the bindings gave it, which keep what it runs (timers.js `atItsTime`), in order of their time, then
// of their arrival — put at the tail, mostly, as they come in order — a storm of 40,000 messages sorted the whole queue at
// each arrival and scanned it at each run: 8.9 s — with each key's last time and how many of it wait, which a key's next
// one is run no earlier than; and whether a turn of the queue's is queued on the event loop, which runs it on as it
// comes, and the time to it)
// (…and, of the realm's requests a service worker answers, the time each was asked at, by its fetch id, which its answer
// lands at the time it took from: `swAnswered`)
#[derive(Default)]
pub(crate) struct Crossings {
    queue: std::collections::VecDeque<(f64, std::rc::Rc<CrossingKey>, f64)>,
    keys: HashMap<std::rc::Rc<str>, std::rc::Rc<CrossingKey>>,
    turn: bool,
    turn_delay: f64,
    asked: HashMap<u32, f64>,
}

// A key with crossings waiting: its name, its last one's time and how many there are. (…each waiting crossing holding it,
// so a storm of one key's — a worker's messages — looks it up once a message, as it comes, with no string made.)
struct CrossingKey {
    name: std::rc::Rc<str>,
    last: std::cell::Cell<f64>,
    waiting: std::cell::Cell<u32>,
}

// __dom.crossingAdd(key, at, id) -> what to run now, as `crossingNext` answers it: crossing `id`, sent by `key`'s sender at
// `at` (on the agent's `Date` scale, as a message's wire carries it — agent_clock.rs `agentShift` — 0 for no time), put
// in the calling realm's crossing queue — nothing while a turn of it is queued, which runs it in its order.
fn crossing_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mut at = args.get(1).number_value(scope).unwrap_or(0.0);
    let id = args.get(2).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    if at > 0.0 {
        at -= crate::agent_clock::agent_shift_of(d, cid);
    }
    // (…one that comes to a queue with nothing waiting nor a turn queued, its key's none — the common case — run now or
    // queued alone, its turn queued with it, the queue's head as `next_crossing` would take it)
    let crossings = &mut d.arena.enter(cid).crossings;
    let alone = crossings.queue.is_empty() && !crossings.turn;
    if alone {
        let when = if at > 0.0 { at } else { 0.0 };
        match turn_due(d, cid, when) {
            None => {
                if when > 0.0 {
                    crate::agent_clock::hold(d, cid, when);
                }
                return rv.set_double(id);
            }
            Some(delay) => {
                let crossings = &mut d.arena.enter(cid).crossings;
                crossings.turn = true;
                crossings.turn_delay = delay;
                rv.set_double(0.0);
            }
        }
    }
    let mut buffer = [std::mem::MaybeUninit::uninit(); 64];
    let name = args.get(0).to_string(scope).map(|k| k.to_rust_cow_lossy(scope, &mut buffer)).unwrap_or_default();
    let crossings = &mut dom(scope).arena.enter(cid).crossings;
    let key = match crossings.keys.get(&*name) {
        Some(key) => key.clone(),
        None => {
            let name: std::rc::Rc<str> = name.as_ref().into();
            let key = std::rc::Rc::new(CrossingKey { name: name.clone(), last: Default::default(), waiting: Default::default() });
            crossings.keys.insert(name, key.clone());
            key
        }
    };
    let when = if at > key.last.get() { at } else { key.last.get() };
    key.last.set(when);
    key.waiting.set(key.waiting.get() + 1);
    // (…at the tail, as they come in order, mostly)
    if crossings.queue.back().is_none_or(|&(w, ..)| w <= when) {
        crossings.queue.push_back((when, key, id));
    } else {
        let at = crossings.queue.partition_point(|&(w, ..)| w <= when);
        crossings.queue.insert(at, (when, key, id));
    }
    if !alone && !crossings.turn {
        next_crossing(scope, cid, &mut rv);
    }
}

// Where a crossing at `when` is to wait for a task of the event loop's that falls due before its time on realm `cid`'s
// own clock: the time to that task, at which a turn of the queue's is to be queued — none where it runs now.
fn turn_due(d: &mut crate::dom::Dom, cid: i32, when: f64) -> Option<f64> {
    let ahead = if when > 0.0 { when - crate::agent_clock::own_now(d, cid) } else { 0.0 };
    if ahead <= 0.0 {
        return None;
    }
    let now = d.arena.event_loop.clock;
    d.arena.agent_first_task().map(|((Due(next), ..), _)| next).filter(|&next| next <= now + ahead).map(|next| next - now)
}

// __dom.crossingNext(turnEnds) -> the calling realm's crossing queue's next to run, now: its head's number, taken, the
// realm's clock held at its time (agent_clock.rs `clockAtLeast`) — or 0 where a task of the event loop's falls due before
// its time on the realm's own clock, a turn of the queue's to be queued (timers.js `runCrossings`) at the time to that
// task (`crossingTurnDelay`): due with the event loop's next task, after those due with it — the agent's own tasks the
// only ones it waits for, none of the queues' turns: another realm's queue's, itself waiting, is none of them
// (`agent_first_task`) — two realms' queues, each seeing the other's turn due now, queued theirs again at one instant ever
// after. Undefined for an empty queue. `turnEnds`: called by a turn of it, which is over.
fn crossing_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let turn_ends = args.get(0).is_true();
    let cid = realm_id(scope, &args);
    if turn_ends {
        dom(scope).arena.enter(cid).crossings.turn = false;
    }
    next_crossing(scope, cid, &mut rv);
}
fn next_crossing(scope: &mut v8::PinScope<'_, '_>, cid: i32, rv: &mut v8::ReturnValue<'_, v8::Value>) {
    let d = dom(scope);
    let crossings = &mut d.arena.enter(cid).crossings;
    let Some(&(when, ..)) = crossings.queue.front() else { return };
    if let Some(delay) = turn_due(d, cid, when) {
        let crossings = &mut d.arena.enter(cid).crossings;
        crossings.turn = true;
        crossings.turn_delay = delay;
        return rv.set_double(0.0);
    }
    let crossings = &mut d.arena.enter(cid).crossings;
    let Some((_, key, id)) = crossings.queue.pop_front() else { return };
    key.waiting.set(key.waiting.get() - 1);
    if key.waiting.get() == 0 {
        crossings.keys.remove(&key.name);
    }
    if when > 0.0 {
        crate::agent_clock::hold(d, cid, when);
    }
    rv.set_double(id);
}

// __dom.crossingTurnDelay() -> the time to the turn of the calling realm's crossing queue that `crossingNext` last asked
// for.
fn crossing_turn_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(dom(scope).arena.enter(cid).crossings.turn_delay);
}

// __dom.agentReady() -> whether the event loop has work to run now: an animation frame callback requested of any of its
// documents (it runs in the step's rendering update), or a task due — without the first a worker's requestAnimationFrame
// with no timer beside it would never fire.
fn agent_ready(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if frames_owed(scope, false) {
        return rv.set_bool(true);
    }
    let arena = &dom(scope).arena;
    let clock = arena.event_loop.clock;
    rv.set_bool(arena.agent_first().is_some_and(|((Due(due), ..), _)| due <= clock));
}

// __dom.agentFramesOwed(animations) -> whether a rendering update is owed to a document of the event loop's: an animation
// frame callback requested — and, with `animations`, an animation its style engine runs waiting on a frame now.
fn agent_frames_owed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let animations = args.get(0).is_true();
    rv.set_bool(frames_owed(scope, animations));
}
fn frames_owed(scope: &mut v8::PinScope<'_, '_>, animations: bool) -> bool {
    let arena = &dom(scope).arena;
    let mut requested = false;
    arena.each_event_loop_realm(|r| requested |= arena.realm_state(r).is_some_and(|s| !s.timers.frames.is_empty()));
    if requested || !animations {
        return requested;
    }
    let realms = dom(scope).arena.event_loop_realms();
    realms.into_iter().any(|r| crate::animation_ops::next_frame_delay_of(scope, r) == Some(0.0))
}

// The event loop's rendering opportunities, as a step takes them (timers.js `runLoopStepBody`): one a frame's interval
// after the last rendering update ran (`EventLoop::rendered`), now at the earliest — HTML's event loop: a task, its
// microtask checkpoint, then a rendering opportunity. (The time a frame's interval after the last ran, none before the
// first.)
impl EventLoop {
    fn next_frame(&self) -> f64 {
        self.rendered.map_or(f64::NEG_INFINITY, |at| at + FRAME_INTERVAL_MS)
    }
}

// __dom.renderBegins() — a rendering update of the event loop's runs now.
fn render_begins(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let event_loop = &mut dom(scope).arena.event_loop;
    event_loop.rendered = Some(event_loop.clock);
}

// __dom.stepRenderOwed(limit, animations) -> whether a rendering update is owed ahead of the next task, which falls due
// later than it (within `limit`) — an animation frame callback queued, or, with `animations`, an animation needing a
// frame now (pending, or with events queued to send), in any document of the event loop — at the next rendering
// opportunity, which the clock is moved on to. The step takes it before it moves the clock on to the task: what a task
// — or a rendering update's own callbacks — queued for the next frame, an animation frame callback, the events of an
// animation it cancelled, is never put off behind a timer due later than that frame.
fn step_render_owed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let animations = args.get(1).is_true();
    let arena = &dom(scope).arena;
    let Some(((Due(due), ..), _)) = arena.agent_first() else { return };
    let at = arena.event_loop.clock.max(arena.event_loop.next_frame());
    if due <= at || due > limit || !frames_owed(scope, animations) {
        return rv.set_bool(false);
    }
    move_clock(scope, at);
    rv.set_bool(true);
}

// __dom.stepRenderAt(limit) -> whether the step takes a rendering update where it has no task due within `limit`: at the
// next rendering opportunity, which the clock is moved on to — none where the budget ends before it (a step that
// yielded, one of no budget, one its clock was pinned short of the next frame): at most one a frame's interval, across
// steps — a rAF loop queuing a 1 ms timer every frame ran its frames 1 ms apart and starved every later timer.
fn step_render_at(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let event_loop = &dom(scope).arena.event_loop;
    let at = event_loop.clock.max(event_loop.next_frame());
    if !(at <= limit) {
        return rv.set_bool(false);
    }
    move_clock(scope, at);
    rv.set_bool(true);
}

// __dom.stepRendered() -> whether a rendering update ran at this instant: a step yielding at a settle change runs one
// first, where none did.
fn step_rendered(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let event_loop = &dom(scope).arena.event_loop;
    rv.set_bool(event_loop.rendered == Some(event_loop.clock));
}

// __dom.stepAnimFrameAt(limit) -> whether an animation the style engine runs in any of the event loop's realms needs a
// frame later than now, within `limit` (`animation_ops::next_frame_delay_of`), the clock moved on to it: the frame at
// which a transition reaches its end is the one that sends its `transitionend` and settles its `finished`, and a step
// that rendered only at its start and then moved the clock past the end never rendered it. None on a page that is
// drawing frames of its own (a queued animation frame callback): its next frame comes anyway, and one between its frames
// would run its callbacks off their cadence.
fn step_anim_frame_at(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    if frames_owed(scope, false) {
        return rv.set_bool(false);
    }
    let realms = dom(scope).arena.event_loop_realms();
    let delay = realms.into_iter().filter_map(|r| crate::animation_ops::next_frame_delay_of(scope, r)).reduce(f64::min);
    let now = dom(scope).arena.event_loop.clock;
    let Some(delay) = delay.filter(|&d| d > 0.0 && now + d <= limit) else { return rv.set_bool(false) };
    move_clock(scope, now + delay);
    rv.set_bool(true);
}

// __dom.stepPin(limit, animations) — the clock moved on to where the step leaves it: `limit`, so a follow-up step
// reflects the virtual time elapsed even where it was idle — but no later than a task its last rendering update queued
// within it (an animation frame callback's `setTimeout(…, 50)`), which the next step then runs at its time, not late; nor
// than the frame owed before it (`stepRenderOwed`) — the events of an animation that callback cancelled — which the next
// step renders first.
fn step_pin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let animations = args.get(1).is_true();
    let arena = &dom(scope).arena;
    let now = arena.event_loop.clock;
    let next_frame = arena.event_loop.next_frame();
    let queued = arena.agent_first().map(|((Due(due), ..), _)| due).filter(|&due| due > now && due < limit);
    let pin = match queued {
        None => limit,
        Some(queued) if frames_owed(scope, animations) => now.max(queued.min(next_frame)),
        Some(queued) => queued,
    };
    move_clock(scope, pin);
}

// __dom.agentRealms() -> the realms of the documents of the event loop, in the order its rendering update takes them
// (navigables.rs `agent_realms`).
fn agent_realms(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realms = dom(scope).arena.agent_realms();
    rv.set(crate::navigables::realm_array(scope, &realms));
}

// __dom.agentSettleGen() -> the event loop's settle generation: what moves with an observable change to any of its
// documents — a frame's listener reaching into its parent, a parent's task into a frame — and never back: its realms'
// generations summed, with those of the realms gone from it since, or begun anew, as they last stood (a frame removed
// as its parent changed took as much from a plain sum as the change added to it).
fn agent_settle_gen(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &mut dom(scope).arena;
    let mut now: HashMap<i32, u32> = HashMap::new();
    for realm in arena.event_loop_realms() {
        if let Some(state) = arena.realm_state(realm) {
            now.insert(realm, state.generations.get(crate::dom::GEN_SETTLE));
        }
    }
    let event_loop = &mut arena.event_loop;
    for (realm, &was) in &event_loop.settle_seen {
        if now.get(realm).is_none_or(|&g| g < was) {
            event_loop.settle_retired += u64::from(was);
        }
    }
    let sum = event_loop.settle_retired + now.values().map(|&g| u64::from(g)).sum::<u64>();
    event_loop.settle_seen = now;
    rv.set_double(sum as f64);
}

// __dom.swAsked(fetchId) — the calling realm's request `fetchId` is asked of its service worker now: the time it was asked
// at on its own clock (agent_clock.rs `own_now`, no hold of a message's in it), on the agent's `Date` scale, as a crossing
// takes a time.
fn sw_asked(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let asked = crate::agent_clock::own_now(d, cid) + crate::agent_clock::agent_shift_of(d, cid);
    d.arena.enter(cid).crossings.asked.insert(id, asked);
}

// __dom.swAnswered(fetchId, spent, took) -> the time the answer to the calling realm's request `fetchId` is run at, in its
// crossing queue (timers.js `atItsTime`) — 0 for one not asked — the request let go of: the time it was asked at, and the
// time the worker spent on it after that (`spent`) — from when it was due to take it, so a service worker spinning 2 s on
// `Date.now()` in its fetch event answers 2 s on, whatever real time the page waited for it meanwhile, and one busy with
// an earlier event first after that one's time too — no less than the time from its event's dispatch (`took`). Lengths of
// time, which the worker's window's clock is none of: a time on it, carried to another window's page, held that page's
// clock at the first window's time — 28.9 s on, after the first ran a 30 s timer chain.
fn sw_answered(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let spent = args.get(1).number_value(scope).unwrap_or(0.0);
    let took = args.get(2).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let asked = dom(scope).arena.enter(cid).crossings.asked.remove(&id);
    rv.set_double(asked.map_or(0.0, |asked| asked + if spent > took { spent } else { took }));
}
