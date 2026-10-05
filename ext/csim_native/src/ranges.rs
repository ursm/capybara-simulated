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
    // Where each point is in its node's list (`Ranges::by_node`), so it leaves it in one step.
    listed: [u32; 2],
}

// Every live range of the isolate — and its points by the node each is in, so a step touches the ranges at the nodes
// it changes, not every range there is (a range a script dropped stays an entry until a major collection takes it).
#[derive(Default)]
pub(crate) struct Ranges {
    entries: Vec<Option<Entry>>,
    free: Vec<u32>,
    by_node: std::collections::HashMap<NodeId, Vec<(u32, u8)>>,
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
            let Some(points) = self.entries.get(id as usize).and_then(|e| e.as_ref()).map(|e| e.points) else { continue };
            for (w, p) in points.iter().enumerate() {
                self.unindex(p.node, id, w);
            }
            self.entries[id as usize] = None;
            self.free.push(id);
        }
    }
    // A new range's entry, both points at `point`.
    fn add(&mut self, handle: WeakPersistent<RangeHandle>, point: Boundary) -> u32 {
        let entry = Some(Entry { handle, points: [point; 2], listed: [0; 2] });
        let id = match self.free.pop() {
            Some(id) => {
                self.entries[id as usize] = entry;
                id
            }
            None => {
                self.entries.push(entry);
                self.entries.len() as u32 - 1
            }
        };
        self.list(point.node, id, START);
        self.list(point.node, id, END);
        id
    }
    // Point `w` of range `id` into `node`'s list…
    fn list(&mut self, node: NodeId, id: u32, w: usize) {
        let list = self.by_node.entry(node).or_default();
        let at = list.len() as u32;
        list.push((id, w as u8));
        if let Some(e) = self.entries[id as usize].as_mut() {
            e.listed[w] = at;
        }
    }
    // …and out of it, the last of the list moved into its place.
    fn unindex(&mut self, node: NodeId, id: u32, w: usize) {
        let Some(at) = self.entries.get(id as usize).and_then(|e| e.as_ref()).map(|e| e.listed[w] as usize) else { return };
        let Some(list) = self.by_node.get_mut(&node) else { return };
        if list.get(at) != Some(&(id, w as u8)) {
            debug_assert!(false, "range {id} point {w} is not where its entry lists it");
            return;
        }
        list.swap_remove(at);
        if let Some(&(moved, mw)) = list.get(at) {
            if let Some(e) = self.entries[moved as usize].as_mut() {
                e.listed[mw as usize] = at as u32;
            }
        }
        if list.is_empty() {
            self.by_node.remove(&node);
        }
    }
    // Point `w` of range `id` is `point` now.
    fn place(&mut self, id: u32, w: usize, point: Boundary) {
        let Some(e) = self.entries.get_mut(id as usize).and_then(|e| e.as_mut()) else { return };
        let old = std::mem::replace(&mut e.points[w], point).node;
        if old != point.node {
            self.unindex(old, id, w);
            self.list(point.node, id, w);
        }
    }
    fn point(&self, id: u32, w: usize) -> Boundary {
        self.entries[id as usize].as_ref().expect("an indexed range's entry").points[w]
    }
    // The points in `node`.
    fn at(&self, node: NodeId) -> Vec<(u32, usize)> {
        self.by_node.get(&node).map_or(Vec::new(), |l| l.iter().map(|&(e, w)| (e, w as usize)).collect())
    }
    // The handle of range `id`, apart from the store's borrow — read before anything allocates on V8's heap.
    fn handle(&self, id: u32) -> Option<*const RangeHandle> {
        self.entries.get(id as usize)?.as_ref()?.handle.get().map(|h| h as *const RangeHandle)
    }
    // Each of `points` moved to `to`, and the handles whose references follow it.
    fn move_to(&mut self, points: &[(u32, usize)], to: Boundary) -> Vec<(*const RangeHandle, usize)> {
        let mut moved = Vec::new();
        for &(id, w) in points {
            self.place(id, w, to);
            if let Some(h) = self.handle(id) {
                moved.push((h, w));
            }
        }
        moved
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
    register(scope, ns, "rangesRemoveAll", ranges_remove_all, context_id);
    register(scope, ns, "rangesReplaceData", ranges_replace_data, context_id);
    register(scope, ns, "rangesSplit", ranges_split, context_id);
    register(scope, ns, "rangesMerge", ranges_merge, context_id);
    register(scope, ns, "rangesLive", ranges_live, context_id);
    register(scope, ns, "isRange", is_range, context_id);
    register(scope, ns, "rangeSetPoint", range_set_point, context_id);
    register(scope, ns, "rangeComparePoint", range_compare_point, context_id);
    register(scope, ns, "rangeCompareBoundaries", range_compare_boundaries, context_id);
    register(scope, ns, "rangeCollapsed", range_collapsed, context_id);
    register(scope, ns, "rangeCommonAncestor", range_common_ancestor, context_id);
    register(scope, ns, "comparePoints", compare_points_op, context_id);
    register(scope, ns, "rangeIntersectsNode", range_intersects_node, context_id);
    register(scope, ns, "rangeText", range_text, context_id);
}

// ── boundary points in tree order (DOM §5.2) ─────────────────────────────────────────────────────────────────────

// `id` and its ancestors, root first — in its node tree (a shadow root is a root).
fn chain(arena: &RealmArena, id: NodeId) -> Vec<NodeId> {
    let mut out = vec![id];
    while let Some(p) = arena.parent_of(*out.last().expect("never empty")) {
        out.push(p);
    }
    out.reverse();
    out
}
// Where `a` is against `b` in tree order — None where they are in different trees.
fn tree_order(arena: &RealmArena, a: NodeId, b: NodeId) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering::*;
    if a == b {
        return Some(Equal);
    }
    let (ca, cb) = (chain(arena, a), chain(arena, b));
    if ca[0] != cb[0] {
        return None;
    }
    let shared = ca.iter().zip(&cb).take_while(|(x, y)| x == y).count();
    // (…an ancestor precedes what it contains)
    let (Some(&xa), Some(&xb)) = (ca.get(shared), cb.get(shared)) else { return Some(if shared == ca.len() { Less } else { Greater }) };
    let index = |n: NodeId| arena.get(n).map_or(0, |d| d.child_index);
    Some(index(xa).cmp(&index(xb)))
}
// "The position of a boundary point relative to another" — None where they are in different trees.
fn compare(arena: &RealmArena, a: Boundary, b: Boundary) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering::*;
    match tree_order(arena, a.node, b.node)? {
        Equal => Some(a.offset.cmp(&b.offset)),
        Greater => compare(arena, b, a).map(std::cmp::Ordering::reverse),
        Less => {
            // (…`a`'s node an ancestor of `b`'s: after where its child towards `b` is before `a`'s offset)
            let cb = chain(arena, b.node);
            match cb.iter().position(|&n| n == a.node) {
                Some(i) => {
                    let child = cb[i + 1];
                    let index = arena.get(child).map_or(0, |d| d.child_index) as u32;
                    Some(if index < a.offset { Greater } else { Less })
                }
                None => Some(Less),
            }
        }
    }
}
fn ordering_value(o: Option<std::cmp::Ordering>) -> Option<i32> {
    o.map(|o| o as i32)
}

// The live entry of the range `value` is the object of, with the arena — or None for no range's.
fn entry_points(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<[Boundary; 2]> {
    let ptr = handle_of(scope, value)?;
    // SAFETY: the handle lives while its object does, which the caller holds.
    let id = unsafe { ptr.as_ref() }.id.get()?;
    ranges(scope).entries.get(id as usize)?.as_ref().map(|e| e.points)
}

// __dom.rangeSetPoint(range, which, node, nid, offset) — DOM "set the start or end" (§5.5), the node and offset checked
// already: the range's start (`which` 0) or end (1) is (`node`, `offset`), and the other point with it where it would
// be in another tree, or on the wrong side.
fn range_set_point(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let which = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(END);
    let (Some(nid), Some(points)) = (nid_arg(scope, &args, 3), entry_points(scope, args.get(0))) else { return range_set(scope, args, rv) };
    let offset = args.get(4).uint32_value(scope).unwrap_or(0);
    let point = Boundary { node: nid, offset };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let other = points[1 - which];
    let order = compare(arena, point, other);
    let collapse = match (which, order) {
        (_, None) => true,
        (START, Some(o)) => o == std::cmp::Ordering::Greater,
        (_, Some(o)) => o == std::cmp::Ordering::Less,
    };
    set_range(scope, &args, if collapse { 2 } else { which });
}
// `range_set`, with `which` decided.
fn set_range(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, which: usize) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let (Ok(node), Some(nid)) = (v8::Local::<v8::Object>::try_from(args.get(2)), nid_arg(scope, args, 3)) else { return };
    let offset = args.get(4).uint32_value(scope).unwrap_or(0);
    // SAFETY: the handle lives while its object does, which the caller holds.
    let h = unsafe { ptr.as_ref() };
    let point = Boundary { node: nid, offset };
    let r = ranges(scope);
    r.sweep();
    let id = match h.id.get() {
        Some(id) => id,
        None => {
            let id = r.add(WeakPersistent::new(&ptr), point);
            h.id.set(Some(id));
            id
        }
    };
    for w in [START, END] {
        if which == w || which == 2 {
            r.place(id, w, point);
        }
    }
    for w in [START, END] {
        if which == w || which == 2 {
            set_point(scope, h, w, node);
        }
    }
}

// __dom.rangeComparePoint(range, nid, offset) -> where the point is against the range: -1 before its start, 1 after its
// end, 0 in it; null in another tree.
fn range_compare_point(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(points), Some(nid)) = (entry_points(scope, args.get(0)), nid_arg(scope, &args, 1)) else { return };
    let point = Boundary { node: nid, offset: args.get(2).uint32_value(scope).unwrap_or(0) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    use std::cmp::Ordering::*;
    let value = match (compare(arena, point, points[START]), compare(arena, point, points[END])) {
        (Some(Less), _) => Some(-1),
        (Some(_), Some(Greater)) => Some(1),
        (Some(_), Some(_)) => Some(0),
        _ => None,
    };
    match value {
        Some(v) => rv.set_int32(v),
        None => rv.set_null(),
    }
}

// __dom.rangeCompareBoundaries(range, how, other) -> `compareBoundaryPoints`: START_TO_START 0, START_TO_END 1,
// END_TO_END 2, END_TO_START 3 — the range's point against the other's; null in another tree, undefined where the
// other is no Range.
fn range_compare_boundaries(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let how = args.get(1).uint32_value(scope).unwrap_or(0);
    let (Some(this), Some(other)) = (entry_points(scope, args.get(0)), entry_points(scope, args.get(2))) else { return };
    let (a, b) = match how {
        0 => (this[START], other[START]),
        1 => (this[END], other[START]),
        2 => (this[END], other[END]),
        _ => (this[START], other[END]),
    };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…in another tree where the two ranges' roots differ: each range's points share a root)
    match ordering_value(compare(arena, a, b)) {
        Some(v) => rv.set_int32(v),
        None => rv.set_null(),
    }
}

// __dom.rangeIntersectsNode(range, nid) -> DOM `intersectsNode` (§5.5): whether the node is in the range's tree and
// (its parent, its index) is before the range's end and (its parent, its index + 1) after its start — a root (a shadow
// root included) always is.
fn range_intersects_node(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(points), Some(nid)) = (entry_points(scope, args.get(0)), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if arena.root_of(nid) != arena.root_of(points[START].node) {
        return rv.set_bool(false);
    }
    let Some(parent) = arena.parent_of(nid) else { return rv.set_bool(true) };
    let offset = arena.get(nid).map_or(0, |n| n.child_index) as u32;
    use std::cmp::Ordering::*;
    let before_end = compare(arena, Boundary { node: parent, offset }, points[END]) == Some(Less);
    let after_start = compare(arena, Boundary { node: parent, offset: offset + 1 }, points[START]) == Some(Greater);
    rv.set_bool(before_end && after_start);
}

// __dom.rangeCollapsed(range) -> whether its start is its end.
fn range_collapsed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some([s, e]) = entry_points(scope, args.get(0)) else { return rv.set_bool(true) };
    rv.set_bool(s.node == e.node && s.offset == e.offset);
}

// __dom.rangeCommonAncestor(range) -> the nid of the nearest inclusive ancestor of both its containers.
fn range_common_ancestor(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some([s, e]) = entry_points(scope, args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let (cs, ce) = (chain(arena, s.node), chain(arena, e.node));
    let shared = cs.iter().zip(&ce).take_while(|(x, y)| x == y).count();
    let common = if shared == 0 { s.node } else { cs[shared - 1] };
    rv.set_double(common.to_f64());
}

// The node after `id` in tree order — into its children first unless `skip_children` — within `id`'s tree.
fn following(arena: &RealmArena, id: NodeId, skip_children: bool) -> Option<NodeId> {
    if !skip_children {
        if let Some(&c) = arena.get(id).and_then(|n| n.children.first()) {
            return Some(c);
        }
    }
    let mut cur = id;
    loop {
        let parent = arena.parent_of(cur)?;
        let at = arena.get(cur)?.child_index;
        if let Some(&next) = arena.get(parent).and_then(|p| p.children.get(at + 1)) {
            return Some(next);
        }
        cur = parent;
    }
}

// __dom.rangeText(range) -> the range's stringifier (DOM §5.5): the start node's data from its offset where it is a Text
// node, the data of every Text node the range contains in tree order, and the end node's up to its offset — or, start
// and end one Text node, its data between them.
fn range_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some([s, e]) = entry_points(scope, args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let text = |id: NodeId| arena.get(id).filter(|n| n.kind == crate::dom::NodeKind::Text).map(|n| &n.data[..]);
    let slice = |d: &[u16], from: u32, to: u32| d[(from as usize).min(d.len())..(to as usize).min(d.len()).max((from as usize).min(d.len()))].to_vec();
    let mut out: Vec<u16> = Vec::new();
    if let (true, Some(d)) = (s.node == e.node, text(s.node)) {
        out = slice(d, s.offset, e.offset);
    } else {
        if let Some(d) = text(s.node) {
            out.extend(slice(d, s.offset, u32::MAX));
        }
        // (…from the first node after the start point: past a Text start node, or the start container's child at the
        // offset, or what follows the container where the offset is its end)
        let mut cur = match text(s.node) {
            Some(_) => following(arena, s.node, true),
            None => match arena.get(s.node).and_then(|n| n.children.get(s.offset as usize)) {
                Some(&c) => Some(c),
                None => following(arena, s.node, true),
            },
        };
        use std::cmp::Ordering::*;
        while let Some(n) = cur {
            // (…until the end node, whose part follows, or a node that starts at or past the end point)
            if n == e.node || compare(arena, Boundary { node: n, offset: 0 }, e) != Some(Less) {
                break;
            }
            if let Some(d) = text(n) {
                let end = Boundary { node: n, offset: d.len() as u32 };
                if compare(arena, end, e) != Some(Greater) {
                    out.extend_from_slice(d);
                }
            }
            cur = following(arena, n, false);
        }
        if let Some(d) = text(e.node) {
            out.extend(slice(d, 0, e.offset));
        }
    }
    let value = crate::dom::utf16_value(scope, &out);
    rv.set(value);
}

// __dom.comparePoints(nidA, offsetA, nidB, offsetB) -> -1, 0 or 1: where the first boundary point is against the
// second; null in another tree.
fn compare_points_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(a), Some(b)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return };
    let a = Boundary { node: a, offset: args.get(1).uint32_value(scope).unwrap_or(0) };
    let b = Boundary { node: b, offset: args.get(3).uint32_value(scope).unwrap_or(0) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    match ordering_value(compare(arena, a, b)) {
        Some(v) => rv.set_int32(v),
        None => rv.set_null(),
    }
}

// __dom.isRange(value) -> whether `value` is a live range's object, any realm's (WebIDL's check for a `Range` argument).
fn is_range(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let yes = handle_of(scope, args.get(0)).is_some();
    rv.set_bool(yes);
}

// __dom.rangesLive() -> how many live ranges the isolate keeps (those V8 collected freed first).
fn ranges_live(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = ranges(scope);
    r.sweep();
    let n = r.entries.iter().flatten().count();
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
    let which = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    set_range(scope, &args, which.min(2));
}

// A TypeError thrown for `this` that is no Range.
fn not_a_range(scope: &mut v8::PinScope<'_, '_>) {
    let message = v8::String::new(scope, "Illegal invocation: the receiver is not a Range.").expect("a short string");
    let error = v8::Exception::type_error(scope, message);
    scope.throw_exception(error);
}

// __dom.rangeContainer(range, which) -> its start's (0) or end's (1) container; a TypeError for no range.
fn range_container(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return not_a_range(scope) };
    let which = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(END);
    // SAFETY: the handle lives while its object does, which the caller holds; the main thread writes the reference.
    if let Some(obj) = unsafe { (*ptr.as_ref().containers[which].get()).get(scope) } {
        rv.set(obj.into());
    }
}

// __dom.rangeOffset(range, which) -> its start's (0) or end's (1) offset; a TypeError for no range.
fn range_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return not_a_range(scope) };
    let which = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(END);
    // SAFETY: as `range_container`.
    let Some(id) = (unsafe { ptr.as_ref() }).id.get() else { return rv.set_uint32(0) };
    let offset = ranges(scope).entries.get(id as usize).and_then(|e| e.as_ref()).map_or(0, |e| e.points[which].offset);
    rv.set_uint32(offset);
}

// Move the handles' references of `moved` to `node`'s object (`Ranges::move_to`).
fn follow(scope: &mut v8::PinScope<'_, '_>, moved: Vec<(*const RangeHandle, usize)>, node: v8::Local<'_, v8::Object>) {
    for (h, w) in moved {
        // SAFETY: a handle a live entry's weak reference named is alive until the next collection, which nothing between
        // `Ranges::handle` and here allocates to start.
        set_point(scope, unsafe { &*h }, w, node);
    }
}

// __dom.rangesInsert(parentNid, index, count) — `count` nodes were inserted into the parent at `index`: a boundary in it
// past that point shifts by them.
fn ranges_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    let index = args.get(1).uint32_value(scope).unwrap_or(0);
    let count = args.get(2).uint32_value(scope).unwrap_or(0);
    let r = ranges(scope);
    r.sweep();
    for (id, w) in r.at(parent) {
        let p = r.point(id, w);
        if p.offset > index {
            r.place(id, w, Boundary { offset: p.offset + count, ..p });
        }
    }
}

// The nodes holding a boundary that `node` is an inclusive ancestor of, in its tree — the points `node`'s removal moves.
fn inside(arena: &RealmArena, r: &Ranges, node: NodeId) -> Vec<(u32, usize)> {
    let mut out = Vec::new();
    for (&n, list) in &r.by_node {
        if contains(arena, node, n) {
            out.extend(list.iter().map(|&(e, w)| (e, w as usize)));
        }
    }
    out
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
    if r.by_node.is_empty() {
        return;
    }
    for (id, w) in r.at(parent) {
        let p = r.point(id, w);
        if p.offset > index {
            r.place(id, w, Boundary { offset: p.offset - 1, ..p });
        }
    }
    let points = inside(arena, r, node);
    let moved = r.move_to(&points, Boundary { node: parent, offset: index });
    follow(scope, moved, parent_obj);
}

// __dom.rangesRemoveAll(parentNid, parent) — every child of the parent (object `parent`) is about to be removed, one after
// another, as "replace all" removes them: a boundary inside any collapses to (parent, 0), as does one in the parent.
fn ranges_remove_all(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    let Ok(parent_obj) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let d = crate::dom::dom(scope);
    let arena = d.arena.enter(cid);
    let r = &mut d.ranges;
    r.sweep();
    if r.by_node.is_empty() {
        return;
    }
    let points: Vec<_> = inside(arena, r, parent).into_iter().filter(|&(id, w)| r.point(id, w).node != parent).collect();
    for (id, w) in r.at(parent) {
        r.place(id, w, Boundary { node: parent, offset: 0 });
    }
    let moved = r.move_to(&points, Boundary { node: parent, offset: 0 });
    follow(scope, moved, parent_obj);
}

// __dom.rangesMerge(nid, node, mergedNid, parentNid, index, length) — `normalize()` merges the text node `mergedNid` (at
// `index` in the parent) into the text node `nid` (object `node`), whose data ran `length` units before it (DOM §4.4
// normalize, steps 6.4-6.5): a boundary in the merged node moves into `node`, past those units, and one in the parent at
// the merged node's index to `node`'s `length`.
fn ranges_merge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(node), Some(merged), Some(parent)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2), nid_arg(scope, &args, 3)) else { return };
    let Ok(node_obj) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let index = args.get(4).uint32_value(scope).unwrap_or(0);
    let length = args.get(5).uint32_value(scope).unwrap_or(0);
    let r = ranges(scope);
    r.sweep();
    let mut moved = Vec::new();
    for (id, w) in r.at(merged) {
        let offset = r.point(id, w).offset + length;
        moved.extend(r.move_to(&[(id, w)], Boundary { node, offset }));
    }
    let at_index: Vec<_> = r.at(parent).into_iter().filter(|&(id, w)| r.point(id, w).offset == index).collect();
    moved.extend(r.move_to(&at_index, Boundary { node, offset: length }));
    follow(scope, moved, node_obj);
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
    for (id, w) in r.at(node) {
        let p = r.point(id, w);
        if p.offset <= offset {
            continue;
        }
        let to = if p.offset <= offset + count { offset } else { p.offset - count + length };
        r.place(id, w, Boundary { offset: to, ..p });
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
    if let Some(parent) = parent {
        for (id, w) in r.at(parent) {
            let p = r.point(id, w);
            if p.offset == slot {
                r.place(id, w, Boundary { offset: p.offset + 1, ..p });
            }
        }
    }
    let mut moved = Vec::new();
    for (id, w) in r.at(node) {
        let p = r.point(id, w);
        if p.offset > offset {
            moved.extend(r.move_to(&[(id, w)], Boundary { node: new_nid, offset: p.offset - offset }));
        }
    }
    follow(scope, moved, new_obj);
}
