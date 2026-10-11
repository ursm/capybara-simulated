// A realm's timers (HTML "map of active timers", §8.6) and the tasks the platform queues on the same list: each its
// handler — a function, or a string run as a script — with its arguments, when it falls due on the realm's virtual
// clock, and the period it repeats at. They run in the order they fall due, and those due at once in the order they
// were scheduled — an interval keeps its place among them as it repeats. The bindings run each as its turn comes
// (timers.js `runLoopStepLocal`) and keep the clock, which every op here is told.
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
    period: Option<f64>,
}

#[derive(Default)]
pub(crate) struct Timers {
    by_key: HashMap<i64, Timer>,
    // The keys in the order they run: by when they are due, then by when they were scheduled.
    order: BTreeSet<(Due, u64, i64)>,
    last_id: i64,
    seq: u64,
    // How many of the realm's event loop steps are running (`timerStep`), and whether its context was disposed while one
    // was: a step goes on with what is due in it — a frame's script removing its own iframe, mid-step, still has the
    // request it sent fail as the step runs on — and the list goes as it ends.
    stepping: u32,
    discarded: bool,
}

// The isolate's task keys: the last one handed out, and the realm each live one is of.
#[derive(Default)]
pub(crate) struct TaskKeys {
    last: i64,
    realms: HashMap<i64, i32>,
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
    fn add(&mut self, key: i64, timer: (v8::Global<v8::Value>, Option<v8::Global<v8::Value>>), due: f64, period: Option<f64>) {
        self.seq += 1;
        self.order.insert((Due(due), self.seq, key));
        self.by_key.insert(key, Timer { due, seq: self.seq, handler: timer.0, args: timer.1, period });
    }
    fn clear(&mut self, key: i64) -> bool {
        let Some(t) = self.by_key.remove(&key) else { return false };
        self.order.remove(&(Due(t.due), t.seq, key));
        true
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
    // …or its context disposed: gone now, or as the step running in it ends (`stepping`).
    pub(crate) fn discard_timers(&mut self, cid: i32) {
        match self.timers_of(cid) {
            Some(timers) if timers.stepping > 0 => timers.discarded = true,
            _ => self.drop_timers(cid),
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "timerAdd", timer_add, context_id);
    register(scope, ns, "timerClear", timer_clear, context_id);
    register(scope, ns, "timerNext", timer_next, context_id);
    register(scope, ns, "timerCount", timer_count, context_id);
    register(scope, ns, "timerNextDue", timer_next_due, context_id);
    register(scope, ns, "timerStep", timer_step, context_id);
}

// __dom.timerStep(begins) — an event loop step of the calling realm's begins, or ends: one ending in a realm whose
// context was disposed during it takes its timers with it (`discard_timers`).
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
    if timers.stepping == 0 && timers.discarded {
        arena.drop_timers(cid);
    }
}

// __dom.timerAdd(handler, args, due, period, task) -> its key: a timer of the calling realm's, falling due at `due` on
// its clock — never, for one that is no finite time — and repeating every `period` ms where that is a number: a page's
// (`task` false: a positive id) or one the platform queues (`task` true: a negative key).
fn timer_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let handler = v8::Global::new(scope, args.get(0));
    let list = args.get(1);
    let list = (!list.is_null_or_undefined()).then(|| v8::Global::new(scope, list));
    let due = args.get(2).number_value(scope).filter(|d| d.is_finite()).unwrap_or(f64::MAX);
    let period = args.get(3).is_number().then(|| args.get(3).number_value(scope).unwrap_or(0.0));
    let task = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let key = if task {
        arena.task_keys.last -= 1;
        arena.task_keys.realms.insert(arena.task_keys.last, cid);
        arena.task_keys.last
    } else {
        let timers = &mut arena.enter(cid).timers;
        timers.last_id += 1;
        timers.last_id
    };
    arena.enter(cid).timers.add(key, (handler, list), due, period);
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

// __dom.timerNext(now, limit) -> `[due, handler, args]`: the calling realm's next timer, where it falls due by `limit` —
// taken from the list, or, one that repeats, due again a period after it runs (`now`, or its due time where that is
// later); undefined for none.
fn timer_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let now = args.get(0).number_value(scope).unwrap_or(0.0);
    let limit = args.get(1).number_value(scope).unwrap_or(f64::INFINITY);
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let timers = &mut arena.enter(cid).timers;
    let Some(&(Due(due), seq, key)) = timers.order.first().filter(|&&(Due(due), _, _)| due <= limit) else { return };
    timers.order.remove(&(Due(due), seq, key));
    let run = due.max(now);
    let repeats = timers.by_key.get(&key).and_then(|t| t.period);
    let (handler, list) = match repeats {
        Some(period) => {
            let Some(t) = timers.by_key.get_mut(&key) else { return };
            t.due = run + period;
            timers.order.insert((Due(t.due), seq, key));
            (t.handler.clone(), t.args.clone())
        }
        None => {
            let Some(t) = timers.by_key.remove(&key) else { return };
            arena.task_keys.realms.remove(&key);
            (t.handler, t.args)
        }
    };
    let due = v8::Number::new(scope, due).into();
    let handler = v8::Local::new(scope, handler);
    let list = list.map_or_else(|| v8::undefined(scope).into(), |l| v8::Local::new(scope, l));
    rv.set(v8::Array::new_with_elements(scope, &[due, handler, list]).into());
}

// __dom.timerCount() -> how many timers the calling realm has.
fn timer_count(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(dom(scope).arena.enter(cid).timers.by_key.len() as u32);
}

// __dom.timerNextDue() -> when the calling realm's next timer falls due, or undefined for none.
fn timer_next_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(&(Due(due), _, _)) = dom(scope).arena.enter(cid).timers.order.first() {
        rv.set_double(due);
    }
}
