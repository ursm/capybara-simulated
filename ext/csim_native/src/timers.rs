// A realm's timers (HTML "map of active timers", §8.6) and the tasks the platform queues on the same list: each its
// handler — a function, or a string run as a script — with its arguments, when it falls due on the realm's virtual
// clock, and the period it repeats at. They run in the order they fall due, and those due at once in the order they
// were scheduled — an interval keeps its place among them as it repeats. The bindings run each as its turn comes
// (timers.js `runLoopStepLocal`) and keep the clock, which every op here is told.
//
// A page's timer is named by a positive id, as `setTimeout` returns one; a task the platform queues by a negative key —
// no page clearing every id it can count to clears the platform's work, and no id it is given skips a number.

use std::collections::{BTreeSet, HashMap};

use crate::dom::{realm, realm_id, register};

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
    last_task: i64,
    seq: u64,
}

// A due time, ordered as the number it is (never NaN: a delay is a non-negative number, and the clock a finite one).
#[derive(Clone, Copy, PartialEq, PartialOrd)]
struct Due(f64);
impl Eq for Due {}
impl Ord for Due {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl Timers {
    fn add(&mut self, handler: v8::Global<v8::Value>, args: Option<v8::Global<v8::Value>>, due: f64, period: Option<f64>, task: bool) -> i64 {
        let key = if task {
            self.last_task -= 1;
            self.last_task
        } else {
            self.last_id += 1;
            self.last_id
        };
        self.seq += 1;
        self.order.insert((Due(due), self.seq, key));
        self.by_key.insert(key, Timer { due, seq: self.seq, handler, args, period });
        key
    }
    fn clear(&mut self, key: i64) -> bool {
        let Some(t) = self.by_key.remove(&key) else { return false };
        self.order.remove(&(Due(t.due), t.seq, key));
        true
    }
    fn next_due(&self) -> Option<f64> {
        self.order.first().map(|&(Due(due), _, _)| due)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "timerAdd", timer_add, context_id);
    register(scope, ns, "timerClear", timer_clear, context_id);
    register(scope, ns, "timerNext", timer_next, context_id);
    register(scope, ns, "timerCount", timer_count, context_id);
    register(scope, ns, "timerNextDue", timer_next_due, context_id);
}

// __dom.timerAdd(handler, args, due, period, task) -> its key: a timer of the calling realm's, falling due at `due` on
// its clock and repeating every `period` ms where that is a number — a page's (`task` false: a positive id) or one the
// platform queues (`task` true: a negative key).
fn timer_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let handler = v8::Global::new(scope, args.get(0));
    let list = args.get(1);
    let list = (!list.is_null_or_undefined()).then(|| v8::Global::new(scope, list));
    let due = args.get(2).number_value(scope).filter(|d| d.is_finite()).unwrap_or(0.0);
    let period = args.get(3).is_number().then(|| args.get(3).number_value(scope).unwrap_or(0.0));
    let task = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let key = realm(scope, cid).timers.add(handler, list, due, period, task);
    rv.set_double(key as f64);
}

// __dom.timerClear(key) -> whether a timer of the calling realm's was cleared.
fn timer_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = args.get(0).integer_value(scope) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(realm(scope, cid).timers.clear(key));
}

// __dom.timerNext(now, limit) -> `[due, handler, args]`: the calling realm's next timer, where it falls due by `limit` —
// taken from the list, or, one that repeats, due again a period after it runs (`now`, or its due time where that is
// later); undefined for none.
fn timer_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let now = args.get(0).number_value(scope).unwrap_or(0.0);
    let limit = args.get(1).number_value(scope).unwrap_or(f64::INFINITY);
    let cid = realm_id(scope, &args);
    let timers = &mut realm(scope, cid).timers;
    let Some(&(Due(due), seq, key)) = timers.order.first().filter(|&&(Due(due), _, _)| due <= limit) else { return };
    timers.order.remove(&(Due(due), seq, key));
    let run = due.max(now);
    let (handler, list) = match timers.by_key.get_mut(&key) {
        Some(t) if t.period.is_some() => {
            t.due = run + t.period.unwrap_or(0.0);
            timers.order.insert((Due(t.due), seq, key));
            (t.handler.clone(), t.args.clone())
        }
        _ => match timers.by_key.remove(&key) {
            Some(t) => (t.handler, t.args),
            None => return,
        },
    };
    let due = v8::Number::new(scope, due).into();
    let handler = v8::Local::new(scope, handler);
    let list = list.map_or_else(|| v8::undefined(scope).into(), |l| v8::Local::new(scope, l));
    rv.set(v8::Array::new_with_elements(scope, &[due, handler, list]).into());
}

// __dom.timerCount() -> how many timers the calling realm has.
fn timer_count(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(realm(scope, cid).timers.by_key.len() as u32);
}

// __dom.timerNextDue() -> when the calling realm's next timer falls due, or undefined for none.
fn timer_next_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(due) = realm(scope, cid).timers.next_due() {
        rv.set_double(due);
    }
}
