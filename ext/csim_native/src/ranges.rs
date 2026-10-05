// Live ranges (DOM §5.5): a Range's boundary points, kept here, and the steps the DOM's mutations run on them — insert,
// remove, replace data, split (§4.2.3, §4.2.4, §4.10, §4.11) — over every live range of the isolate, wherever its tree.
//
// A Range's object is a wrapper of a handle on V8's C++ heap (`__dom.RangeBase`, as a node's is: node_handle.rs), which
// traces the boundary containers' objects — what `startContainer` / `endContainer` hand out, and what keeps them alive
// while the range is — so a range is collected with whatever it is in a cycle with. The arena's ids say where each
// boundary is; a step that moves a boundary to another node is handed that node's object (the removed node's parent, a
// split's new node), so the handle's reference follows. A collected range's entry is freed at the next op on ranges.

use std::cell::{Cell, RefCell, UnsafeCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use v8::cppgc::{GarbageCollected, Visitor, WeakPersistent};

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1).
const TAG: u16 = 2;

// What marks an object as a range's (its internal field 0).
static BRAND: u8 = 0;

const START: usize = 0;
const END: usize = 1;

pub(crate) struct RangeHandle {
    // The range's entry (`Ranges::entries`), or none until a boundary is set; and the queue of the isolate's ranges.
    id: Cell<Option<u32>>,
    dead: RefCell<Weak<Dead>>,
    // The boundary containers' objects, start and end. Written on the main thread only.
    containers: [UnsafeCell<v8::TracedReference<v8::Object>>; 2],
}

unsafe impl GarbageCollected for RangeHandle {
    fn trace(&self, visitor: &mut Visitor) {
        for c in &self.containers {
            // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
            visitor.trace(unsafe { &*c.get() });
        }
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"RangeHandle"
    }
}

impl Drop for RangeHandle {
    fn drop(&mut self) {
        if let (Some(id), Some(dead)) = (self.id.get(), self.dead.get_mut().upgrade()) {
            dead.ids.lock().unwrap_or_else(|e| e.into_inner()).push(id);
            dead.pending.store(true, Ordering::Release);
        }
    }
}

// The entries of the ranges V8 collected, to be freed.
#[derive(Default)]
pub(crate) struct Dead {
    pending: AtomicBool,
    ids: Mutex<Vec<u32>>,
}

#[derive(Clone, Copy)]
struct Boundary {
    node: NodeId,
    offset: u32,
}

struct Entry {
    handle: WeakPersistent<RangeHandle>,
    points: [Boundary; 2],
}

// Every live range of the isolate.
#[derive(Default)]
pub(crate) struct Ranges {
    entries: Vec<Option<Entry>>,
    free: Vec<u32>,
    dead: Arc<Dead>,
    template: Option<v8::Global<v8::FunctionTemplate>>,
}

impl Ranges {
    // Free the entries of collected ranges. One atomic load when there are none.
    fn sweep(&mut self) {
        if !self.dead.pending.swap(false, Ordering::Acquire) {
            return;
        }
        let ids = std::mem::take(&mut *self.dead.ids.lock().unwrap_or_else(|e| e.into_inner()));
        for id in ids {
            if let Some(e) = self.entries.get_mut(id as usize) {
                *e = None;
                self.free.push(id);
            }
        }
    }
    fn live(&mut self) -> impl Iterator<Item = &mut Entry> {
        self.entries.iter_mut().flatten()
    }
}

// The isolate's ranges.
fn ranges<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Ranges {
    &mut crate::dom::dom(scope).ranges
}

// Whether `node` is an inclusive ancestor of `of` in its node tree — not across a shadow root, whose tree is its own (a
// range inside one is not disturbed by its host's removal).
fn contains(arena: &RealmArena, node: NodeId, of: NodeId) -> bool {
    let mut cur = Some(of);
    while let Some(n) = cur {
        if n == node {
            return true;
        }
        cur = arena.parent_of(n);
    }
    false
}

// The constructor a Range's object is made with (`__dom.RangeBase`): branded, and a wrapper of a fresh handle.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let dead = Arc::downgrade(&ranges(scope).dead);
    let handle = RangeHandle {
        id: Cell::new(None),
        dead: RefCell::new(dead),
        containers: [UnsafeCell::new(v8::TracedReference::empty()), UnsafeCell::new(v8::TracedReference::empty())],
    };
    let heap = scope.get_cpp_heap().expect("RangeBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, RangeHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no range's object (the brand first: `unwrap` reads garbage from
// an object it never wrapped).
fn handle_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<v8::cppgc::UnsafePtr<RangeHandle>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a RangeHandle under TAG.
    unsafe { v8::Object::unwrap::<TAG, RangeHandle>(scope, obj) }
}

// `__dom.RangeBase`: the constructor of the isolate's template, made once per isolate.
pub(crate) fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let template = match ranges(scope).template.clone() {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "RangeBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            ranges(scope).template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "rangeSet", range_set, context_id);
    register(scope, ns, "rangeContainer", range_container, context_id);
    register(scope, ns, "rangeOffset", range_offset, context_id);
    register(scope, ns, "rangesInsert", ranges_insert, context_id);
    register(scope, ns, "rangesRemove", ranges_remove, context_id);
    register(scope, ns, "rangesReplaceData", ranges_replace_data, context_id);
    register(scope, ns, "rangesSplit", ranges_split, context_id);
    register(scope, ns, "rangesLive", ranges_live, context_id);
}

// __dom.rangesLive() -> how many live ranges the isolate keeps (those V8 collected freed first).
fn ranges_live(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = ranges(scope);
    r.sweep();
    let n = r.live().count();
    rv.set_uint32(n as u32);
}

// The point `which` of a range (0 its start, 1 its end; 2 both), and the object of the node it is in.
fn set_point(scope: &mut v8::PinScope<'_, '_>, h: &RangeHandle, which: usize, node: v8::Local<'_, v8::Object>) {
    // SAFETY: the main thread, which alone writes the references; the assignment runs TracedReference's barrier.
    unsafe { (*h.containers[which].get()).reset(scope, Some(node)) }
}

// __dom.rangeSet(range, which, node, nid, offset) — the range's start (`which` 0), end (1) or both (2) is (`node`,
// `offset`), `nid` the node's slot.
fn range_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let (Ok(node), Some(nid)) = (v8::Local::<v8::Object>::try_from(args.get(2)), nid_arg(scope, &args, 3)) else { return };
    let offset = args.get(4).uint32_value(scope).unwrap_or(0);
    // SAFETY: the handle lives while its object does, which the caller holds.
    let h = unsafe { ptr.as_ref() };
    let point = Boundary { node: nid, offset };
    let r = ranges(scope);
    r.sweep();
    let id = match h.id.get() {
        Some(id) => id,
        None => {
            let entry = Entry { handle: WeakPersistent::new(&ptr), points: [point; 2] };
            let id = match r.free.pop() {
                Some(id) => {
                    r.entries[id as usize] = Some(entry);
                    id
                }
                None => {
                    r.entries.push(Some(entry));
                    r.entries.len() as u32 - 1
                }
            };
            h.id.set(Some(id));
            id
        }
    };
    let e = r.entries[id as usize].as_mut().expect("a live range's entry");
    for w in [START, END] {
        if which == w || which == 2 {
            e.points[w] = point;
        }
    }
    for w in [START, END] {
        if which == w || which == 2 {
            set_point(scope, h, w, node);
        }
    }
}

// __dom.rangeContainer(range, which) -> its start's (0) or end's (1) container.
fn range_container(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let which = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(END);
    // SAFETY: the handle lives while its object does, which the caller holds; the main thread writes the reference.
    if let Some(obj) = unsafe { (*ptr.as_ref().containers[which].get()).get(scope) } {
        rv.set(obj.into());
    }
}

// __dom.rangeOffset(range, which) -> its start's (0) or end's (1) offset.
fn range_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let which = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(END);
    // SAFETY: as `range_container`.
    let Some(id) = (unsafe { ptr.as_ref() }).id.get() else { return rv.set_uint32(0) };
    let offset = ranges(scope).entries.get(id as usize).and_then(|e| e.as_ref()).map_or(0, |e| e.points[which].offset);
    rv.set_uint32(offset);
}

// __dom.rangesInsert(parentNid, index, count) — `count` nodes were inserted into the parent at `index`: a boundary in it
// past that point shifts by them.
fn ranges_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    let index = args.get(1).uint32_value(scope).unwrap_or(0);
    let count = args.get(2).uint32_value(scope).unwrap_or(0);
    let r = ranges(scope);
    r.sweep();
    for e in r.live() {
        for p in &mut e.points {
            if p.node == parent && p.offset > index {
                p.offset += count;
            }
        }
    }
}

// __dom.rangesRemove(parentNid, parent, nid, index) — the node `nid` (at `index` in the parent, whose object `parent` is)
// is about to be removed: a boundary inside it collapses to (parent, index), and one in the parent past it shifts left.
fn ranges_remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(parent), Some(node)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return };
    let Ok(parent_obj) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let index = args.get(3).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let d = crate::dom::dom(scope);
    let arena = d.arena.enter(cid);
    let r = &mut d.ranges;
    r.sweep();
    // (…the handles whose references follow a boundary to the parent, written once the arena is let go)
    let mut moved: Vec<(*const RangeHandle, usize)> = Vec::new();
    for e in r.entries.iter_mut().flatten() {
        for (w, p) in e.points.iter_mut().enumerate() {
            if contains(arena, node, p.node) {
                *p = Boundary { node: parent, offset: index };
                if let Some(h) = e.handle.get() {
                    moved.push((h as *const RangeHandle, w));
                }
            } else if p.node == parent && p.offset > index {
                p.offset -= 1;
            }
        }
    }
    for (h, w) in moved {
        // SAFETY: a handle a live entry's weak reference named is alive until the next collection, which nothing here
        // allocates to start.
        set_point(scope, unsafe { &*h }, w, parent_obj);
    }
}

// __dom.rangesReplaceData(nid, offset, count, length) — `count` code units at `offset` of the node's data were replaced
// by `length` units: a boundary inside the replaced span clamps to `offset`, one after it shifts by the difference.
fn ranges_replace_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let count = args.get(2).uint32_value(scope).unwrap_or(0);
    let length = args.get(3).uint32_value(scope).unwrap_or(0);
    let r = ranges(scope);
    r.sweep();
    for e in r.live() {
        for p in &mut e.points {
            if p.node != node || p.offset <= offset {
                continue;
            }
            p.offset = if p.offset <= offset + count { offset } else { p.offset - count + length };
        }
    }
}

// __dom.rangesSplit(nid, offset, newNode, newNid, parentNid, slot) — the node was split at `offset`, its tail now the
// node `newNid` (object `newNode`) at `slot` in the parent (-1 for none): a boundary past the split point moves into the
// new node, and one in the parent at its slot shifts right.
fn ranges_split(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(node), Some(new_nid)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 3)) else { return };
    let Ok(new_obj) = v8::Local::<v8::Object>::try_from(args.get(2)) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let parent = nid_arg(scope, &args, 4);
    let slot = args.get(5).uint32_value(scope).unwrap_or(0);
    let r = ranges(scope);
    r.sweep();
    let mut moved: Vec<(*const RangeHandle, usize)> = Vec::new();
    for e in r.entries.iter_mut().flatten() {
        for (w, p) in e.points.iter_mut().enumerate() {
            if p.node == node && p.offset > offset {
                *p = Boundary { node: new_nid, offset: p.offset - offset };
                if let Some(h) = e.handle.get() {
                    moved.push((h as *const RangeHandle, w));
                }
            } else if Some(p.node) == parent && p.offset == slot {
                p.offset += 1;
            }
        }
    }
    for (h, w) in moved {
        // SAFETY: as `ranges_remove`.
        set_point(scope, unsafe { &*h }, w, new_obj);
    }
}
