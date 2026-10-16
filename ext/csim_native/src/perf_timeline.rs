// A realm's performance timeline (Performance Timeline §5–6, User Timing §2, Resource Timing §4): its entry buffers —
// the marks and measures in the order they were recorded, the resources in the primary buffer (bounded by its size, 250
// until the page sets another) and the secondary buffer that catches the overflow until `resourcetimingbufferfull` has
// fired and the page has made room, or not — its last performance entry id and its document's navigation id, and its
// registered performance observers, each with the types it observes, the entries queued on it and whether its next
// callback reports dropped entries, and whether the task that calls them back is queued. The entries and observers
// themselves, their state in their slots, are the bindings' (performance.js), which hand each entry in with the facts
// the timeline filters, orders and looks marks up by, and name each observer by the number `poCreate` gave it; a
// buffered or queued entry and a registered observer are held — roots, which the realm's context going lets go of
// (`discard_perf_timeline`) — and the realm's state, begun anew with each page, holds none.

use crate::dom::{realm_id, utf16_arg, RealmArena};

// The entry types the timeline buffers and observers observe, as the bindings name them — a bit each, as an observer's
// types are kept.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Mark = 1,
    Measure = 2,
    Resource = 4,
}

impl Kind {
    fn of(name: &str) -> Option<Kind> {
        match name {
            "mark" => Some(Kind::Mark),
            "measure" => Some(Kind::Measure),
            "resource" => Some(Kind::Resource),
            _ => None,
        }
    }
}

struct Entry {
    held: v8::Global<v8::Value>,
    kind: Kind,
    // (…as the page wrote it, a lone surrogate and all: two names it tells apart are two marks)
    name: Vec<u16>,
    start: f64,
}

// A registered performance observer, in the order it registered.
struct Observer {
    id: u32,
    held: v8::Global<v8::Value>,
    // The types it observes, a `Kind` bit each.
    types: u8,
    queue: Vec<v8::Global<v8::Value>>,
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
    last_entry_id: Option<u64>,
    navigation_id: Option<u64>,
    observers: Vec<Observer>,
    next_observer: u32,
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
            last_entry_id: None,
            navigation_id: None,
            observers: Vec::new(),
            next_observer: 0,
            observer_task_queued: false,
        }
    }
}

// What a new entry, or an observe(), leaves the bindings to queue (`perfRecord`, `poObserve`).
const BUFFER_FULL_TASK: u32 = 1;
const OBSERVER_TASK: u32 = 2;

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
    // "Filter buffer map by name and type" (§2.1): the buffered entries of the type, named the name, in start time
    // order — those that start together as they were recorded, the marks and measures before the resources.
    fn filtered(&self, kind: Option<Kind>, name: Option<&[u16]>) -> Vec<v8::Global<v8::Value>> {
        let mut found: Vec<&Entry> =
            self.entries.iter().chain(&self.primary).filter(|e| kind.is_none_or(|k| e.kind == k) && name.is_none_or(|n| e.name == n)).collect();
        found.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
        found.into_iter().map(|e| e.held.clone()).collect()
    }
    // The task calling the observers back queued, unless it is: what the bindings are left to queue.
    fn queue_observer_task(&mut self) -> u32 {
        if std::mem::replace(&mut self.observer_task_queued, true) { 0 } else { OBSERVER_TASK }
    }
    fn observer(&mut self, id: u32) -> Option<&mut Observer> {
        self.observers.iter_mut().find(|o| o.id == id)
    }
}

impl RealmArena {
    // Realm `cid`'s context disposed — a frame removed or navigated: its entries and observers held no more, nor what
    // they reach of its heap (the context with them).
    pub(crate) fn discard_perf_timeline(&mut self, cid: i32) {
        let timeline = if cid == self.cur() { Some(&mut self.perf_timeline) } else { self.parked_state(cid).map(|s| &mut s.perf_timeline) };
        if let Some(timeline) = timeline {
            *timeline = PerfTimeline::default();
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "perfRecord", perf_record, context_id);
    crate::dom::register(scope, ns, "perfEntries", perf_entries, context_id);
    crate::dom::register(scope, ns, "perfMarkTime", perf_mark_time, context_id);
    crate::dom::register(scope, ns, "perfClear", perf_clear, context_id);
    crate::dom::register(scope, ns, "perfSetResourceBufferSize", perf_set_resource_buffer_size, context_id);
    crate::dom::register(scope, ns, "perfOverflow", perf_overflow, context_id);
    crate::dom::register(scope, ns, "perfCopyOverflow", perf_copy_overflow, context_id);
    crate::dom::register(scope, ns, "poCreate", po_create, context_id);
    crate::dom::register(scope, ns, "poObserve", po_observe, context_id);
    crate::dom::register(scope, ns, "poDisconnect", po_disconnect, context_id);
    crate::dom::register(scope, ns, "poTakeRecords", po_take_records, context_id);
    crate::dom::register(scope, ns, "poTask", po_task, context_id);
}

fn timeline<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'s mut PerfTimeline {
    let cid = realm_id(scope, args);
    &mut crate::dom::realm(scope, cid).perf_timeline
}

fn values<'s>(scope: &mut v8::PinScope<'s, '_>, held: &[v8::Global<v8::Value>]) -> v8::Local<'s, v8::Value> {
    let locals: Vec<v8::Local<v8::Value>> = held.iter().map(|g| v8::Local::new(scope, g)).collect();
    v8::Array::new_with_elements(scope, &locals).into()
}

// __dom.perfRecord(entry, type, name, startTime, withNavigation) -> `[navigationId, id, tasks]`: the entry queued ("queue
// a PerformanceEntry") and buffered. Queued, its id is generated — after its document's most recent navigation's, drawn
// first, so it is the smaller, where it has a document (`withNavigation`), else 0 (a worker's: the spec's null, which the
// attribute's `unsigned long long` makes 0, as Chrome reports) — and it is queued on every registered observer of its
// type. Buffered, a mark or a measure is the last recorded; a resource goes in the primary buffer while it has room and
// no buffer-full task is queued, else in the secondary one ("add a PerformanceResourceTiming entry"). `tasks` says what
// the bindings are to queue: the buffer-full task (1) — for the first in the secondary buffer — and the observers' (2).
fn perf_record(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let entry = args.get(0);
    let kind = Kind::of(&args.get(1).to_rust_string_lossy(scope));
    let name = utf16_arg(scope, args.get(2));
    let start = args.get(3).number_value(scope).unwrap_or(0.0);
    let with_navigation = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let held = v8::Global::new(scope, entry);
    // (…buffered and queued by no realm whose context is gone: the entry would root the context it is in, which nothing
    // lets go of again before the next visit)
    let keep = entry.is_object() && !crate::dom::realm(scope, cid).context_gone(cid);
    let t = &mut crate::dom::realm(scope, cid).perf_timeline;
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
    if let Some(kind) = kind.filter(|_| keep) {
        let mut observed = false;
        for o in t.observers.iter_mut().filter(|o| o.types & kind as u8 != 0) {
            o.queue.push(held.clone());
            observed = true;
        }
        if observed {
            tasks |= t.queue_observer_task();
        }
        let entry = Entry { held, kind, name, start };
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
    let navigation = v8::Number::new(scope, navigation as f64);
    let id = v8::Number::new(scope, id as f64);
    let tasks = v8::Integer::new_from_unsigned(scope, tasks);
    rv.set(v8::Array::new_with_elements(scope, &[navigation.into(), id.into(), tasks.into()]).into());
}

// __dom.perfEntries(type, name) -> the buffered entries (`filtered`) of `type` where it is a string, named `name`
// where it is one.
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
    rv.set(values(scope, &found));
}

// __dom.perfMarkTime(name) -> the start time of the most recent mark named `name`, or null for none (User Timing §3.1
// "convert a mark to a timestamp").
fn perf_mark_time(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = utf16_arg(scope, args.get(0));
    let t = timeline(scope, &args);
    match t.entries.iter().rev().find(|e| e.kind == Kind::Mark && e.name == name) {
        Some(e) => rv.set_double(e.start),
        None => rv.set_null(),
    }
}

// __dom.perfClear(type, name) — the buffered marks or measures (`type`) named `name`, or all of them where it is no
// string, let go of; the resources' primary buffer emptied (clearResourceTimings).
fn perf_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(kind) = Kind::of(&args.get(0).to_rust_string_lossy(scope)) else { return };
    let name = Some(args.get(1)).filter(|n| n.is_string()).map(|n| utf16_arg(scope, n));
    let t = timeline(scope, &args);
    if kind == Kind::Resource {
        t.primary.clear();
    } else {
        t.entries.retain(|e| e.kind != kind || name.as_ref().is_some_and(|n| e.name != *n));
    }
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

// __dom.perfCopyOverflow(before) -> whether the steps go round again: the secondary buffer copied to the primary while
// it has room, and — where that left it no smaller than the `before` it held as this round began (the page made no
// room) — the rest dropped, and the task done.
fn perf_copy_overflow(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let before = args.get(0).uint32_value(scope).unwrap_or(0) as usize;
    let t = timeline(scope, &args);
    t.copy_secondary();
    if before <= t.secondary.len() {
        t.secondary.clear();
        t.full_pending = false;
        return rv.set_bool(false);
    }
    rv.set_bool(true);
}

// __dom.poCreate() -> the number naming a new PerformanceObserver.
fn po_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = timeline(scope, &args);
    t.next_observer += 1;
    rv.set_uint32(t.next_observer);
}

// __dom.poObserve(id, observer, types, replace, bufferedType) -> the tasks the bindings are to queue (`perfRecord`'s):
// observer `id` (`observer`) observing `types` — its types replaced by them (observe({entryTypes})) or they added
// (observe({type})) — its next callback reporting dropped entries, and registered where it is not; with a
// `bufferedType`, the entries already buffered of it queued on it. With no types, it stays as it was, but for the
// dropped entries.
fn po_observe(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_uint32(0) };
    let observer = args.get(1);
    let types = u8::try_from(args.get(2).uint32_value(scope).unwrap_or(0) & 7).unwrap_or(0);
    let replace = args.get(3).is_true();
    let buffered = Some(args.get(4)).filter(|b| b.is_string()).and_then(|b| Kind::of(&b.to_rust_string_lossy(scope)));
    let cid = realm_id(scope, &args);
    // (…none by a realm whose context is gone: the observer would root the context it is in)
    if !observer.is_object() || crate::dom::realm(scope, cid).context_gone(cid) {
        return rv.set_uint32(0);
    }
    let held = v8::Global::new(scope, observer);
    let t = &mut crate::dom::realm(scope, cid).perf_timeline;
    if let Some(o) = t.observer(id) {
        o.requires_dropped_entries = true;
    }
    if types == 0 {
        return rv.set_uint32(0);
    }
    if t.observer(id).is_none() {
        t.observers.push(Observer { id, held, types: 0, queue: Vec::new(), requires_dropped_entries: true });
    }
    let entries = buffered.map(|kind| t.filtered(Some(kind), None)).unwrap_or_default();
    let o = t.observer(id).expect("registered above");
    o.types = if replace { types } else { o.types | types };
    let queued = !entries.is_empty();
    o.queue.extend(entries);
    rv.set_uint32(if queued { t.queue_observer_task() } else { 0 });
}

// __dom.poDisconnect(id) — observer `id` registered no more, its queue and types let go of.
fn po_disconnect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    timeline(scope, &args).observers.retain(|o| o.id != id);
}

// __dom.poTakeRecords(id, forCallback) -> the entries queued on observer `id`, its queue emptied; for its callback
// (`forCallback`), `[entries, droppedEntriesCount]` — the count, none (ours never fill), the first time since an
// observe(), else undefined — or null with none queued.
fn po_take_records(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let for_callback = args.get(1).is_true();
    let t = timeline(scope, &args);
    let Some(o) = t.observer(id) else {
        return if for_callback { rv.set_null() } else { rv.set(v8::Array::new(scope, 0).into()) };
    };
    if for_callback && o.queue.is_empty() {
        return rv.set_null();
    }
    let queue = std::mem::take(&mut o.queue);
    let dropped = for_callback && std::mem::replace(&mut o.requires_dropped_entries, false);
    let entries = values(scope, &queue);
    if !for_callback {
        return rv.set(entries);
    }
    let dropped: v8::Local<v8::Value> = if dropped { v8::Integer::new(scope, 0).into() } else { v8::undefined(scope).into() };
    rv.set(v8::Array::new_with_elements(scope, &[entries, dropped]).into());
}

// __dom.poTask() -> the registered observers, in the order they registered, as the PerformanceObserver task begins (a
// copy: one registered by a callback waits for the next) — `[id, observer, …]` — the task queued no more.
fn po_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let t = timeline(scope, &args);
    t.observer_task_queued = false;
    let observers: Vec<(u32, v8::Global<v8::Value>)> = t.observers.iter().map(|o| (o.id, o.held.clone())).collect();
    let mut flat: Vec<v8::Local<v8::Value>> = Vec::with_capacity(observers.len() * 2);
    for (id, held) in &observers {
        flat.push(v8::Integer::new_from_unsigned(scope, *id).into());
        flat.push(v8::Local::new(scope, held));
    }
    rv.set(v8::Array::new_with_elements(scope, &flat).into());
}
