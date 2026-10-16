// A realm's performance timeline (Performance Timeline §5, User Timing §2, Resource Timing §4): its entry buffers — the
// marks and measures in the order they were recorded, the resources in the primary buffer (bounded by its size, 250
// until the page sets another) and the secondary buffer that catches the overflow until `resourcetimingbufferfull` has
// fired and the page has made room, or not — and its last performance entry id and its document's navigation id. The
// entries themselves, their state in their slots, are the bindings' (performance.js), which hand each in with the
// facts the timeline filters, orders and looks marks up by; a buffered one is held — a root, which the realm's context
// going lets go of (`discard_perf_timeline`) — and the realm's state, begun anew with each page, holds none.

use crate::dom::{realm_id, utf16_arg, RealmArena};

// The entry types the timeline buffers, as the bindings name them.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Mark,
    Measure,
    Resource,
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
}

impl Default for PerfTimeline {
    fn default() -> Self {
        PerfTimeline { entries: Vec::new(), primary: Vec::new(), secondary: Vec::new(), size: 250, full_pending: false, last_entry_id: None, navigation_id: None }
    }
}

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
}

impl RealmArena {
    // Realm `cid`'s context disposed — a frame removed or navigated: its entries held no more, nor what they reach of
    // its heap (the context with them).
    pub(crate) fn discard_perf_timeline(&mut self, cid: i32) {
        let timeline = if cid == self.cur() { Some(&mut self.perf_timeline) } else { self.parked_state(cid).map(|s| &mut s.perf_timeline) };
        if let Some(timeline) = timeline {
            *timeline = PerfTimeline::default();
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "perfQueueIds", perf_queue_ids, context_id);
    crate::dom::register(scope, ns, "perfRecord", perf_record, context_id);
    crate::dom::register(scope, ns, "perfEntries", perf_entries, context_id);
    crate::dom::register(scope, ns, "perfMarkTime", perf_mark_time, context_id);
    crate::dom::register(scope, ns, "perfClear", perf_clear, context_id);
    crate::dom::register(scope, ns, "perfSetResourceBufferSize", perf_set_resource_buffer_size, context_id);
    crate::dom::register(scope, ns, "perfOverflow", perf_overflow, context_id);
    crate::dom::register(scope, ns, "perfCopyOverflow", perf_copy_overflow, context_id);
}

fn timeline<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'s mut PerfTimeline {
    let cid = realm_id(scope, args);
    &mut crate::dom::realm(scope, cid).perf_timeline
}

// __dom.perfQueueIds(withNavigation) -> `[navigationId, id]` of an entry queued now ("queue a PerformanceEntry"): its
// id generated, after its document's most recent navigation's — drawn first, so it is the smaller — where it has a
// document (`withNavigation`), else 0 (a worker's: the spec's null, which the attribute's `unsigned long long` makes 0,
// as Chrome reports).
fn perf_queue_ids(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let with_navigation = args.get(0).is_true();
    let t = timeline(scope, &args);
    let navigation = if with_navigation {
        match t.navigation_id {
            Some(id) => id,
            None => {
                let id = t.generate_id();
                *t.navigation_id.insert(id)
            }
        }
    } else {
        0
    };
    let id = t.generate_id();
    let navigation = v8::Number::new(scope, navigation as f64);
    let id = v8::Number::new(scope, id as f64);
    rv.set(v8::Array::new_with_elements(scope, &[navigation.into(), id.into()]).into());
}

// __dom.perfRecord(entry, type, name, startTime) -> whether a buffer-full task is to be queued: the entry buffered — a
// mark or a measure as the last recorded, a resource in the primary buffer while it has room and no buffer-full task is
// queued, else in the secondary one, the first of which queues that task ("add a PerformanceResourceTiming entry").
fn perf_record(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let entry = args.get(0);
    let kind = Kind::of(&args.get(1).to_rust_string_lossy(scope));
    let name = utf16_arg(scope, args.get(2));
    let start = args.get(3).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    // (…none by a realm whose context is gone: the entry would root the context it is in, which nothing lets go of
    // again before the next visit)
    let Some(kind) = kind.filter(|_| entry.is_object() && !crate::dom::realm(scope, cid).context_gone(cid)) else { return rv.set_bool(false) };
    let entry = Entry { held: v8::Global::new(scope, entry), kind, name, start };
    let t = &mut crate::dom::realm(scope, cid).perf_timeline;
    if kind != Kind::Resource {
        t.entries.push(entry);
        return rv.set_bool(false);
    }
    if t.can_add_resource() && !t.full_pending {
        t.primary.push(entry);
        return rv.set_bool(false);
    }
    let queue = !t.full_pending;
    t.full_pending = true;
    t.secondary.push(entry);
    rv.set_bool(queue);
}

// __dom.perfEntries(type, name) -> the buffered entries ("filter buffer map by name and type", §2.1) — of `type`
// where it is a string, named `name` where it is one — in start time order, those that start together as they were
// recorded, the marks and measures before the resources.
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
    let t = timeline(scope, &args);
    let mut found: Vec<(f64, v8::Global<v8::Value>)> = t.entries.iter().chain(&t.primary)
        .filter(|e| kind.is_none_or(|k| e.kind == k) && name.as_ref().is_none_or(|n| e.name == *n))
        .map(|e| (e.start, e.held.clone()))
        .collect();
    found.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let locals: Vec<v8::Local<v8::Value>> = found.iter().map(|(_, g)| v8::Local::new(scope, g)).collect();
    rv.set(v8::Array::new_with_elements(scope, &locals).into());
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
