// A realm's performance timeline (Performance Timeline §5–6, User Timing §2, Resource Timing §4): its entry buffers —
// the marks and measures in the order they were recorded, the resources in the primary buffer (bounded by its size, 250
// until the page sets another) and the secondary buffer that catches the overflow until `resourcetimingbufferfull` has
// fired and the page has made room, or not, with the count of those it dropped — its last performance entry id and its
// document's navigation id, and its registered performance observers, each with the types it observes and whether its
// next callback reports dropped entries, and whether the task that calls them back is queued.
//
// It holds no object: the entries and observers are the bindings' (performance.js), which hand each entry in with the
// facts the timeline filters, orders and looks marks up by and keep the objects themselves by the serial it answers
// with — the buffered entries until it lets them go, as its answers say, an observer's queue in the observer's slots —
// and name each observer by the number `poCreate` gave it. So what holds them is what holds the realm's `performance`,
// and a frame removed keeps a timeline that works, as Chrome's does, its objects going with the frame's.

use crate::dom::{realm_id, utf16_arg};

// The entry types the timeline buffers and observers observe, as the bindings name them — a bit each, as an observer's
// types are kept.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Mark = 1,
    Measure = 2,
    Resource = 4,
}

impl Kind {
    // …each by its name, in alphabetical order: PerformanceObserver's supportedEntryTypes (§6.4).
    const NAMED: [(&'static str, Kind); 3] = [("mark", Kind::Mark), ("measure", Kind::Measure), ("resource", Kind::Resource)];
    fn of(name: &str) -> Option<Kind> {
        Kind::NAMED.iter().find(|(n, _)| *n == name).map(|&(_, k)| k)
    }
}

struct Entry {
    // The number the bindings keep its object by.
    serial: u32,
    kind: Kind,
    // (…as the page wrote it, a lone surrogate and all: two names it tells apart are two marks)
    name: Vec<u16>,
    start: f64,
}

// A registered performance observer, in the order it registered.
struct Observer {
    id: u32,
    // The types it observes, a `Kind` bit each.
    types: u8,
    requires_dropped_entries: bool,
}

pub(crate) struct PerfTimeline {
    // Marks and measures, as they were recorded.
    entries: Vec<Entry>,
    primary: Vec<Entry>,
    secondary: Vec<Entry>,
    size: u32,
    // Whether a buffer-full task is queued: an entry meanwhile goes to the secondary buffer.
    full_pending: bool,
    // How many resources the secondary buffer dropped (the resource tuple's "dropped entries count").
    dropped_resources: u32,
    next_serial: u32,
    last_entry_id: Option<u64>,
    navigation_id: Option<u64>,
    observers: Vec<Observer>,
    next_observer: u32,
    // Each observer's type, as its first observe() fixed it — whether it observes by `entryTypes` ('multiple') — kept
    // past a disconnect(), as the observer's own (Performance Timeline §6 "observer type"), until it is collected.
    observer_types: std::collections::HashMap<u32, bool>,
    // Whether the PerformanceObserver task is queued — one at a time.
    observer_task_queued: bool,
}

impl Default for PerfTimeline {
    fn default() -> Self {
        PerfTimeline {
            entries: Vec::new(),
            primary: Vec::new(),
            secondary: Vec::new(),
            size: 250,
            full_pending: false,
            dropped_resources: 0,
            next_serial: 0,
            last_entry_id: None,
            navigation_id: None,
            observers: Vec::new(),
            next_observer: 0,
            observer_types: std::collections::HashMap::new(),
            observer_task_queued: false,
        }
    }
}

// What a new entry, or an observe(), leaves the bindings to queue (`perfRecord`, `poObserve`).
const BUFFER_FULL_TASK: u32 = 1;
const OBSERVER_TASK: u32 = 2;
// …and that an observe() registered the observer: it observes a supported type.
const OBSERVER_REGISTERED: u32 = 4;

impl PerfTimeline {
    // "Generate an id" (§5.7): the last performance entry id, starting at a random integer between 100 and 10000 and
    // raised by one for each entry — drawn when the first is asked for.
    fn generate_id(&mut self) -> u64 {
        use rand_core::RngCore as _;
        let id = self.last_entry_id.get_or_insert_with(|| 100 + u64::from(rand_core::OsRng.next_u32() % 9900));
        *id += 1;
        *id
    }
    fn can_add_resource(&self) -> bool {
        self.primary.len() < self.size as usize
    }
    // "Copy secondary buffer": its entries moved to the primary buffer while it has room.
    fn copy_secondary(&mut self) {
        let room = (self.size as usize).saturating_sub(self.primary.len()).min(self.secondary.len());
        self.primary.extend(self.secondary.drain(..room));
    }
    // "Filter buffer map by name and type" (§2.1): the serials of the buffered entries of the type, named the name, in
    // start time order — those that start together as they were recorded, the marks and measures before the resources.
    fn filtered(&self, kind: Option<Kind>, name: Option<&[u16]>) -> Vec<u32> {
        let mut found: Vec<&Entry> =
            self.entries.iter().chain(&self.primary).filter(|e| kind.is_none_or(|k| e.kind == k) && name.is_none_or(|n| e.name == n)).collect();
        // (…no start is NaN — `perf_record` makes one 0 — so this is a total order, and `-0` starts with `0`)
        found.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
        found.into_iter().map(|e| e.serial).collect()
    }
    // The task calling the observers back queued, unless it is: what the bindings are left to queue.
    fn queue_observer_task(&mut self) -> u32 {
        if std::mem::replace(&mut self.observer_task_queued, true) { 0 } else { OBSERVER_TASK }
    }
    fn observer(&mut self, id: u32) -> Option<&mut Observer> {
        self.observers.iter_mut().find(|o| o.id == id)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "perfRecord", perf_record, context_id);
    crate::dom::register(scope, ns, "perfEntries", perf_entries, context_id);
    crate::dom::register(scope, ns, "perfMeasure", perf_measure, context_id);
    crate::dom::register(scope, ns, "perfEntryTypes", perf_entry_types, context_id);
    crate::dom::register(scope, ns, "perfTimingName", perf_timing_name, context_id);
    crate::dom::register(scope, ns, "perfClear", perf_clear, context_id);
    crate::dom::register(scope, ns, "perfSetResourceBufferSize", perf_set_resource_buffer_size, context_id);
    crate::dom::register(scope, ns, "perfOverflow", perf_overflow, context_id);
    crate::dom::register(scope, ns, "perfCopyOverflow", perf_copy_overflow, context_id);
    crate::dom::register(scope, ns, "poCreate", po_create, context_id);
    crate::dom::register(scope, ns, "poForget", po_forget, context_id);
    crate::dom::register(scope, ns, "poObserve", po_observe, context_id);
    crate::dom::register(scope, ns, "poDisconnect", po_disconnect, context_id);
    crate::dom::register(scope, ns, "poTask", po_task, context_id);
    crate::dom::register(scope, ns, "poDroppedEntries", po_dropped_entries, context_id);
}

fn timeline<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'s mut PerfTimeline {
    let cid = realm_id(scope, args);
    &mut crate::dom::realm(scope, cid).perf_timeline
}

fn numbers<'s>(scope: &mut v8::PinScope<'s, '_>, values: impl IntoIterator<Item = f64>) -> v8::Local<'s, v8::Value> {
    let locals: Vec<v8::Local<v8::Value>> = values.into_iter().map(|v| v8::Number::new(scope, v).into()).collect();
    v8::Array::new_with_elements(scope, &locals).into()
}
fn serials<'s>(scope: &mut v8::PinScope<'s, '_>, entries: impl IntoIterator<Item = u32>) -> v8::Local<'s, v8::Value> {
    numbers(scope, entries.into_iter().map(f64::from))
}

// __dom.perfRecord(type, name, startTime, withNavigation) -> `[navigationId, id, tasks, serial, observer…]`: an entry
// queued ("queue a PerformanceEntry") and buffered. Queued, its id is generated — after its document's most recent
// navigation's, drawn first, so it is the smaller, where it has a document (`withNavigation`), else 0 (a worker's: the
// spec's null, which the attribute's `unsigned long long` makes 0, as Chrome reports) — and the registered observers of
// its type named, for the bindings to queue it on. Buffered — under `serial`, which the bindings keep its object by — a
// mark or a measure is the last recorded; a resource goes in the primary buffer while it has room and no buffer-full
// task is queued, else in the secondary one ("add a PerformanceResourceTiming entry"). `tasks` says what the bindings
// are to queue: the buffer-full task (1) — for the first in the secondary buffer — and the observers' (2).
fn perf_record(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = Kind::of(&args.get(0).to_rust_string_lossy(scope));
    let name = utf16_arg(scope, args.get(1));
    // (…a NaN start, which no IDL `double` lets through, ordered as JS's comparator orders one: as 0)
    let start = args.get(2).number_value(scope).filter(|s| !s.is_nan()).unwrap_or(0.0);
    let with_navigation = args.get(3).is_true();
    let t = timeline(scope, &args);
    let navigation = match (with_navigation, t.navigation_id) {
        (false, _) => 0,
        (true, Some(id)) => id,
        (true, None) => {
            let id = t.generate_id();
            *t.navigation_id.insert(id)
        }
    };
    let id = t.generate_id();
    let mut tasks = 0;
    let mut serial = 0;
    let mut observers = Vec::new();
    if let Some(kind) = kind {
        observers.extend(t.observers.iter().filter(|o| o.types & kind as u8 != 0).map(|o| o.id));
        if !observers.is_empty() {
            tasks |= t.queue_observer_task();
        }
        t.next_serial += 1;
        serial = t.next_serial;
        let entry = Entry { serial, kind, name, start };
        if kind != Kind::Resource {
            t.entries.push(entry);
        } else if t.can_add_resource() && !t.full_pending {
            t.primary.push(entry);
        } else {
            if !t.full_pending {
                tasks |= BUFFER_FULL_TASK;
            }
            t.full_pending = true;
            t.secondary.push(entry);
        }
    }
    let head = [navigation as f64, id as f64, f64::from(tasks), f64::from(serial)];
    rv.set(numbers(scope, head.into_iter().chain(observers.into_iter().map(f64::from))));
}

// __dom.perfEntries(type, name) -> the serials of the buffered entries (`filtered`) of `type` where it is a string,
// named `name` where it is one.
fn perf_entries(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…a type the timeline buffers none of: none)
    let kind = match args.get(0) {
        k if k.is_string() => match Kind::of(&k.to_rust_string_lossy(scope)) {
            Some(kind) => Some(kind),
            None => return rv.set(v8::Array::new(scope, 0).into()),
        },
        _ => None,
    };
    let name = Some(args.get(1)).filter(|n| n.is_string()).map(|n| utf16_arg(scope, n));
    let found = timeline(scope, &args).filtered(kind, name.as_deref());
    rv.set(serials(scope, found));
}

// The PerformanceTiming interface's attribute names (User Timing §3.2): what a mark may not be named in a Window, and
// what a measure reads as a navigation timestamp — Navigation Timing is not modelled, so every one but navigationStart
// is an event that "hasn't happened yet".
const PERFORMANCE_TIMING_NAMES: [&str; 21] = [
    "navigationStart", "unloadEventStart", "unloadEventEnd", "redirectStart", "redirectEnd", "fetchStart",
    "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart", "requestStart",
    "responseStart", "responseEnd", "domLoading", "domInteractive", "domContentLoadedEventStart",
    "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd",
];
fn performance_timing_name(name: &[u16]) -> bool {
    PERFORMANCE_TIMING_NAMES.iter().any(|n| n.encode_utf16().eq(name.iter().copied()))
}

// What "convert a mark to a timestamp" refuses (User Timing §3.1), each its error: a negative number (a TypeError), a
// PerformanceTiming name in a worker (a TypeError), one of an event that has not happened (an InvalidAccessError), a
// name no mark has (a SyntaxError).
const MARK_NEGATIVE: f64 = -1.0;
const MARK_TIMING_IN_WORKER: f64 = -2.0;
const MARK_TIMING_EMPTY: f64 = -3.0;
const MARK_NONE: f64 = -4.0;

// "Convert a mark to a timestamp" (User Timing §3.1) of `mark`, in a window or not: a number itself; a PerformanceTiming
// name navigation's (§3.2: navigationStart 0, every other an event not yet happened); any other name the start time of
// the most recent mark of it — or, refused, one of the `MARK_*` codes (each below 0, which no timestamp is).
fn mark_timestamp(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, mark: v8::Local<'_, v8::Value>, in_window: bool) -> f64 {
    if mark.is_number() {
        // (…a number that is none no timestamp either — the bindings' conversion lets none through)
        let at = mark.number_value(scope).unwrap_or(f64::NAN);
        return if at < 0.0 || at.is_nan() { MARK_NEGATIVE } else { at };
    }
    let name = utf16_arg(scope, mark);
    if performance_timing_name(&name) {
        return if !in_window {
            MARK_TIMING_IN_WORKER
        } else if name == "navigationStart".encode_utf16().collect::<Vec<u16>>() {
            0.0
        } else {
            MARK_TIMING_EMPTY
        };
    }
    let t = timeline(scope, args);
    t.entries.iter().rev().find(|e| e.kind == Kind::Mark && e.name == name).map_or(MARK_NONE, |e| e.start)
}

// __dom.perfEntryTypes() -> the entry types the timeline supports, by name (`Kind::NAMED`).
fn perf_entry_types(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let names: Vec<v8::Local<v8::Value>> = Kind::NAMED.iter().filter_map(|(n, _)| v8::String::new(scope, n)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &names).into());
}

// What measure()'s options refuse (User Timing §3.1.3, each a TypeError): an end mark beside non-empty options, options
// with neither a start nor an end, options with all of a start, a duration and an end.
const MEASURE_END_MARK: f64 = 1.0;
const MEASURE_NO_START_OR_END: f64 = 2.0;
const MEASURE_ALL_THREE: f64 = 3.0;

// __dom.perfMeasure(inWindow, now, options, endMark, start, end, duration, startMark) -> [0, startTime, endTime], or what
// refuses it: [MEASURE_* code, -1], or [MARK_* code, which] — the argument whose mark it was (3 the end mark, 4 the
// start, 5 the end, 6 the duration, 7 the start mark). The measure() steps (User Timing §3.1.3): `options` 0 for a
// start mark given (`startMark`), 1 for empty options, 2 for options with members — `start`, `end`, `duration`
// undefined for each absent; the end time the end mark's, the end's, the start plus the duration, or `now`; the start
// time the start's, the end less the duration, the start mark's, or 0 — each mark converted as its turn comes.
fn perf_measure(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let in_window = args.get(0).is_true();
    let now = args.get(1).number_value(scope).unwrap_or(0.0);
    let options = args.get(2).uint32_value(scope).unwrap_or(0);
    let given = |i: i32| !args.get(i).is_undefined();
    let (end_mark, start, end, duration) = (given(3), given(4), given(5), given(6));
    if options == 2 {
        let code = if end_mark {
            MEASURE_END_MARK
        } else if !start && !end {
            MEASURE_NO_START_OR_END
        } else if start && duration && end {
            MEASURE_ALL_THREE
        } else {
            0.0
        };
        if code != 0.0 {
            return rv.set(numbers(scope, [code, -1.0]));
        }
    }
    // (…a mark converted, or the op answered with its refusal)
    macro_rules! at {
        ($i:expr) => {{
            let at = mark_timestamp(scope, &args, args.get($i), in_window);
            if at < 0.0 {
                return rv.set(numbers(scope, [at, f64::from($i)]));
            }
            at
        }};
    }
    let end_time = if end_mark {
        at!(3)
    } else if end {
        at!(5)
    } else if start && duration {
        at!(4) + at!(6)
    } else {
        now
    };
    let start_time = if start {
        at!(4)
    } else if duration && end {
        at!(5) - at!(6)
    } else if options == 0 {
        at!(7)
    } else {
        0.0
    };
    rv.set(numbers(scope, [0.0, start_time, end_time]));
}
// __dom.perfTimingName(name) -> whether `name` is a PerformanceTiming attribute's name (User Timing §3.2).
fn perf_timing_name(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = utf16_arg(scope, args.get(0));
    rv.set_bool(performance_timing_name(&name));
}

// __dom.perfClear(type, name) -> the serials of the entries let go of: the buffered marks or measures (`type`) named
// `name`, or all of them where it is no string; the resources' primary buffer (clearResourceTimings).
fn perf_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(kind) = Kind::of(&args.get(0).to_rust_string_lossy(scope)) else { return rv.set(v8::Array::new(scope, 0).into()) };
    let name = Some(args.get(1)).filter(|n| n.is_string()).map(|n| utf16_arg(scope, n));
    let t = timeline(scope, &args);
    let mut gone = Vec::new();
    if kind == Kind::Resource {
        gone.extend(t.primary.drain(..).map(|e| e.serial));
    } else {
        t.entries.retain(|e| {
            let clear = e.kind == kind && name.as_ref().is_none_or(|n| e.name == *n);
            if clear {
                gone.push(e.serial);
            }
            !clear
        });
    }
    rv.set(serials(scope, gone));
}

// __dom.perfSetResourceBufferSize(maxSize) — the primary buffer's size, which takes effect at once (a raise during the
// `resourcetimingbufferfull` handler makes room for the waiting entries).
fn perf_set_resource_buffer_size(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let size = args.get(0).uint32_value(scope).unwrap_or(0);
    timeline(scope, &args).size = size;
}

// __dom.perfOverflow() -> how many resources the secondary buffer holds, and whether the primary buffer has room for
// one — `[count, room]` — as the buffer-full task's steps go round ("fire a buffer full event"); with none left, the
// task done: an entry after it goes to the primary buffer again.
fn perf_overflow(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = timeline(scope, &args);
    let count = t.secondary.len() as u32;
    let room = t.can_add_resource();
    if count == 0 {
        t.full_pending = false;
    }
    let count = v8::Integer::new_from_unsigned(scope, count);
    let room = v8::Boolean::new(scope, room);
    rv.set(v8::Array::new_with_elements(scope, &[count.into(), room.into()]).into());
}

// __dom.perfCopyOverflow(before) -> the serials of the resources dropped — none while the steps go round again: the
// secondary buffer copied to the primary while it has room, and — where that left it no smaller than the `before` it
// held as this round began (the page made no room) — the rest dropped, counted, and the task done.
fn perf_copy_overflow(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let before = args.get(0).uint32_value(scope).unwrap_or(0) as usize;
    let t = timeline(scope, &args);
    t.copy_secondary();
    let mut dropped = Vec::new();
    if before <= t.secondary.len() {
        dropped.extend(t.secondary.drain(..).map(|e| e.serial));
        t.dropped_resources = t.dropped_resources.saturating_add(dropped.len() as u32);
        t.full_pending = false;
    }
    rv.set(serials(scope, dropped));
}

// __dom.poCreate() -> the number naming a new PerformanceObserver.
fn po_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = timeline(scope, &args);
    t.next_observer += 1;
    rv.set_uint32(t.next_observer);
}

// __dom.poObserve(id, types, multiple, bufferedType) -> `[tasks, serial…]`: observer `id` observing `types` (their names,
// the supported among them) — its types replaced by them (observe({entryTypes}), `multiple`) or they added
// (observe({type})) — its next callback reporting dropped entries, and registered where it is not; with a
// `bufferedType`, the serials of the entries already buffered of it, for the bindings to queue on it, and the observers'
// task (`perfRecord`'s 2) where that queues any, and 4 where it is registered. With no supported types, it stays as it
// was, but for the dropped entries. Null — an InvalidModificationError — where its first observe() was the other of the
// two, disconnect() or no disconnect() (a bool an observer keeps until it is collected: `poForget`).
fn po_observe(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let mut types = 0u8;
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..list.length() {
            if let Some(kind) = list.get_index(scope, i).and_then(|v| Kind::of(&v.to_rust_string_lossy(scope))) {
                types |= kind as u8;
            }
        }
    }
    let replace = args.get(2).is_true();
    let buffered = Some(args.get(3)).filter(|b| b.is_string()).and_then(|b| Kind::of(&b.to_rust_string_lossy(scope)));
    let t = timeline(scope, &args);
    if *t.observer_types.entry(id).or_insert(replace) != replace {
        return rv.set_null();
    }
    if let Some(o) = t.observer(id) {
        o.requires_dropped_entries = true;
    }
    if types == 0 {
        return rv.set(serials(scope, [0]));
    }
    if t.observer(id).is_none() {
        t.observers.push(Observer { id, types: 0, requires_dropped_entries: true });
    }
    let o = t.observer(id).expect("registered above");
    o.types = if replace { types } else { o.types | types };
    let entries = buffered.map(|kind| t.filtered(Some(kind), None)).unwrap_or_default();
    let tasks = OBSERVER_REGISTERED | if entries.is_empty() { 0 } else { t.queue_observer_task() };
    rv.set(serials(scope, std::iter::once(tasks).chain(entries)));
}

// __dom.poForget(id) — observer `id` collected (it was registered no more): its type let go of too.
fn po_forget(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let t = timeline(scope, &args);
    t.observer_types.remove(&id);
    t.observers.retain(|o| o.id != id);
}

// __dom.poDisconnect(id) — observer `id` registered no more, its types let go of.
fn po_disconnect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    timeline(scope, &args).observers.retain(|o| o.id != id);
}

// __dom.poTask() -> the registered observers, in the order they registered, as the PerformanceObserver task begins (a
// copy: one registered by a callback waits for the next) — the task queued no more.
fn po_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = timeline(scope, &args);
    t.observer_task_queued = false;
    let ids: Vec<u32> = t.observers.iter().map(|o| o.id).collect();
    rv.set(serials(scope, ids));
}

// __dom.poDroppedEntries(id) -> the count of entries dropped from full buffers of the types observer `id` observes, the
// first time its callback asks since an observe() — null after (the callback's options carry none).
fn po_dropped_entries(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let t = timeline(scope, &args);
    let dropped_resources = t.dropped_resources;
    match t.observer(id).filter(|o| o.requires_dropped_entries) {
        Some(o) => {
            o.requires_dropped_entries = false;
            rv.set_uint32(if o.types & Kind::Resource as u8 != 0 { dropped_resources } else { 0 });
        }
        None => rv.set_null(),
    }
}
