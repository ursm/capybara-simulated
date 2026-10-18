// A document's selection (Selection API §2): the one range a script or the user selected in it, or none, and the
// direction it was selected in — and what each of its members makes of them: the anchor and focus, whether the range
// counts (it is in the document's own tree), and the range a change selects in its place, its points in order, or
// collapsed where they are in different trees. A Selection's object holds a handle on V8's C++ heap
// (`__dom.SelectionBase`, as a range's does: ranges.rs) that names its document and traces its range's object, held by
// reference: a script's changes to it are the selection's, and so are the DOM's, which update it as the live range it is.
// The bindings make the range a change selects (a new one, which the change's points are set on here), throw what a
// change refuses, and schedule the `selectionchange` a change owes.

use std::cell::{Cell, UnsafeCell};
use std::cmp::Ordering;

use v8::cppgc::{GarbageCollected, Visitor};

use crate::dom::{nid_arg, realm, realm_id, NodeId, RealmArena};
use crate::range_contents::node_length;
use crate::ranges::{compare_points, container, points, set_points};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, a range's 2, an iterator's 3, a canvas
// state's 4, a canvas paint's 5).
const TAG: u16 = 6;

// What marks an object as a selection's (its internal field 0).
static BRAND: u8 = 0;

// The direction the range was selected in.
const NONE: u8 = 0;
const FORWARD: u8 = 1;
const BACKWARD: u8 = 2;

pub(crate) struct SelectionHandle {
    document: Cell<Option<NodeId>>,
    direction: Cell<u8>,
    // The range's object, or none: no selection.
    range: UnsafeCell<v8::TracedReference<v8::Object>>,
}

unsafe impl GarbageCollected for SelectionHandle {
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
        visitor.trace(unsafe { &*self.range.get() });
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"SelectionHandle"
    }
}

impl SelectionHandle {
    fn range<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        // SAFETY: the main thread reads the reference; nothing else writes it meanwhile.
        unsafe { (*self.range.get()).get(scope) }
    }
    // The range is `range` now (none: the selection is empty), selected in `direction`.
    fn select(&self, scope: &mut v8::PinScope<'_, '_>, range: Option<v8::Local<'_, v8::Object>>, direction: u8) {
        // SAFETY: as `range`.
        unsafe { (*self.range.get()).reset(scope, range) };
        self.direction.set(direction);
    }
}

// The constructor a selection's state object is made with (`__dom.SelectionBase(documentNid)`): branded, a wrapper of a
// fresh handle, empty.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = SelectionHandle {
        document: Cell::new(nid_arg(scope, &args, 0)),
        direction: Cell::new(NONE),
        range: UnsafeCell::new(v8::TracedReference::empty()),
    };
    let heap = scope.get_cpp_heap().expect("SelectionBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, SelectionHandle>(scope, obj, &ptr);
    }
}

// The handle a selection argument wraps, or None for anything that is no selection's state object (the brand first:
// `unwrap` reads garbage from an object it never wrapped).
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h SelectionHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a SelectionHandle under TAG; the handle lives while
    // its object, the argument, does — through the op.
    unsafe { v8::Object::unwrap::<TAG, SelectionHandle>(scope, obj) }.map(|p| unsafe { &*(p.as_ref() as *const SelectionHandle) })
}

// `__dom.SelectionBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).selection_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "SelectionBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).selection_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "SelectionBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "selectionGet", selection_get, context_id);
    crate::dom::register(scope, ns, "selectionSet", selection_set, context_id);
    crate::dom::register(scope, ns, "selectionDirect", selection_direct, context_id);
    crate::dom::register(scope, ns, "selectionCollapse", selection_collapse, context_id);
    crate::dom::register(scope, ns, "selectionCollapseTo", selection_collapse_to, context_id);
    crate::dom::register(scope, ns, "selectionExtend", selection_extend, context_id);
    crate::dom::register(scope, ns, "selectionBaseAndExtent", selection_base_and_extent, context_id);
    crate::dom::register(scope, ns, "selectionSelectChildren", selection_select_children, context_id);
    crate::dom::register(scope, ns, "selectionAddRange", selection_add_range, context_id);
    crate::dom::register(scope, ns, "selectionRemoveRange", selection_remove_range, context_id);
    crate::dom::register(scope, ns, "selectionContains", selection_contains, context_id);
    crate::dom::register(scope, ns, "selectionComposed", selection_composed, context_id);
}

// What a member reads (`selectionGet`), by the code the bindings name it with.
const ANCHOR_NODE: u32 = 0;
const ANCHOR_OFFSET: u32 = 1;
const FOCUS_NODE: u32 = 2;
const FOCUS_OFFSET: u32 = 3;
const IS_COLLAPSED: u32 = 4;
const RANGE_COUNT: u32 = 5;
const TYPE: u32 = 6;
const DIRECTION: u32 = 7;
// …the range, wherever it is, or null…
const RANGE: u32 = 8;
// …the range where it counts (getRangeAt's, deleteFromDocument's), or null…
const COUNTED_RANGE: u32 = 9;
// …and the focus, [node, offset], wherever it is (`modify` moves it), or null.
const FOCUS: u32 = 10;

// What a change came to: nothing (a point out of the document, or a range a selection that has one does not take),
// a change — a `selectionchange` owed — or an error the bindings throw: there is no selection (InvalidStateError), the
// node is a doctype (InvalidNodeTypeError), the offset is past its length (IndexSizeError), the range is not the
// selection's (NotFoundError).
const IGNORED: u32 = 0;
const CHANGED: u32 = 1;
const EMPTY: u32 = 2;
const DOCTYPE: u32 = 3;
const OFFSET: u32 = 4;
const NOT_FOUND: u32 = 5;

// A point: its node's object, the node, the offset.
type Point<'s> = (v8::Local<'s, v8::Object>, NodeId, u32);

// The selection's state as a member reads it: its range's points, and where they are.
struct Selected {
    start: (NodeId, u32),
    end: (NodeId, u32),
    backward: bool,
    // Whether the range is in the document's own tree — not in a shadow tree, nor out of the document (its two points
    // are in one tree, so its start says): whether it counts.
    counted: bool,
}

impl Selected {
    fn anchor_is_end(&self) -> bool {
        self.backward
    }
    // The anchor and the focus: the start and the end, the other way round where it was selected backwards.
    fn anchor(&self) -> (NodeId, u32) {
        if self.anchor_is_end() { self.end } else { self.start }
    }
    fn focus(&self) -> (NodeId, u32) {
        if self.anchor_is_end() { self.start } else { self.end }
    }
}

fn selected(scope: &mut v8::PinScope<'_, '_>, cid: i32, sel: &SelectionHandle) -> Option<Selected> {
    let range = sel.range(scope)?;
    let [start, end] = points(scope, range.into())?;
    let counted = Some(realm(scope, cid).root_of(start.0)) == sel.document.get();
    Some(Selected { start, end, backward: sel.direction.get() == BACKWARD, counted })
}

// The object of a point the range has: its start's container (0) or its end's (1).
fn container_of<'s>(scope: &mut v8::PinScope<'s, '_>, sel: &SelectionHandle, which: usize) -> Option<v8::Local<'s, v8::Object>> {
    let range = sel.range(scope)?;
    container(scope, range.into(), which)
}

// __dom.selectionGet(selection, code) -> what the member `code` names (`ANCHOR_NODE` …) reads.
fn selection_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sel) = handle(scope, args.get(0)) else { return };
    let code = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let cid = realm_id(scope, &args);
    let s = selected(scope, cid, sel);
    let counted = s.as_ref().filter(|s| s.counted);
    match code {
        ANCHOR_NODE | FOCUS_NODE => {
            let Some(s) = counted else { return rv.set_null() };
            let which = usize::from((code == FOCUS_NODE) != s.anchor_is_end());
            match container_of(scope, sel, which) {
                Some(node) => rv.set(node.into()),
                None => rv.set_null(),
            }
        }
        ANCHOR_OFFSET => rv.set_uint32(counted.map_or(0, |s| s.anchor().1)),
        FOCUS_OFFSET => rv.set_uint32(counted.map_or(0, |s| s.focus().1)),
        // (…the anchor and the focus the same point, both null included — wherever they are)
        IS_COLLAPSED => rv.set_bool(s.as_ref().is_none_or(|s| s.start == s.end)),
        RANGE_COUNT => rv.set_uint32(u32::from(counted.is_some())),
        TYPE => {
            let name = match counted {
                None => "None",
                Some(s) if s.start == s.end => "Caret",
                Some(_) => "Range",
            };
            rv.set(v8::String::new(scope, name).expect("a short string").into());
        }
        DIRECTION => {
            let name = match (s.is_some(), sel.direction.get()) {
                (false, _) | (true, NONE) => "none",
                (true, FORWARD) => "forward",
                _ => "backward",
            };
            rv.set(v8::String::new(scope, name).expect("a short string").into());
        }
        RANGE | COUNTED_RANGE => match sel.range(scope).filter(|_| code == RANGE || counted.is_some()) {
            Some(range) => rv.set(range.into()),
            None => rv.set_null(),
        },
        FOCUS => {
            let Some(s) = s else { return rv.set_null() };
            let which = usize::from(!s.anchor_is_end());
            let Some(node) = container_of(scope, sel, which) else { return rv.set_null() };
            let offset = v8::Integer::new_from_unsigned(scope, s.focus().1);
            rv.set(v8::Array::new_with_elements(scope, &[node.into(), offset.into()]).into());
        }
        _ => {}
    }
}

// The range argument `i`'s object, or None for null (or anything that is no object).
fn object_arg<'s>(args: &v8::FunctionCallbackArguments<'s>, i: i32) -> Option<v8::Local<'s, v8::Object>> {
    v8::Local::<v8::Object>::try_from(args.get(i)).ok()
}
// The point arguments `i` (the node's object), `i + 1` (its slot) and `i + 2` (the offset).
fn point_arg<'s>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'s>, i: i32) -> Option<Point<'s>> {
    let node = object_arg(args, i)?;
    let nid = nid_arg(scope, args, i + 1)?;
    Some((node, nid, args.get(i + 2).uint32_value(scope).unwrap_or(0)))
}
fn direction_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> u8 {
    args.get(i).uint32_value(scope).map_or(NONE, |d| (d as u8).min(BACKWARD))
}

// __dom.selectionSet(selection, range, direction): the range is `range`, as the bindings set it, selected in `direction`
// (`NONE` 0, `FORWARD` 1, `BACKWARD` 2) — none of a script's checks: the driver's selecting, as the user does, wherever
// in the document (`__csimSelect`), and `modify`'s move.
fn selection_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(range)) = (handle(scope, args.get(0)), object_arg(&args, 1)) else { return };
    let direction = direction_arg(scope, &args, 2);
    sel.select(scope, Some(range), direction);
}

// __dom.selectionDirect(selection, forward) — the direction `modify` sets as it moves the focus, whether or not it then
// moves: no change of the range.
fn selection_direct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sel) = handle(scope, args.get(0)) else { return };
    sel.direction.set(if args.get(1).boolean_value(scope) { FORWARD } else { BACKWARD });
}

// What a point a range cannot have comes to: a doctype's, or one past its node's length.
fn check_point(arena: &RealmArena, (nid, offset): (NodeId, u32)) -> Option<u32> {
    crate::range_contents::point_error(arena, nid, offset).map(|e| match e {
        crate::range_contents::PointError::Doctype => DOCTYPE,
        crate::range_contents::PointError::PastLength => OFFSET,
    })
}
// Whether the document is a shadow-including inclusive ancestor of `nid` — where collapse, extend and setBaseAndExtent
// take a point at all.
fn in_document(arena: &RealmArena, sel: &SelectionHandle, nid: NodeId) -> bool {
    Some(arena.shadow_including_root(nid)) == sel.document.get()
}

// `fresh`, a range the bindings made for the change, from `start` to `end` (collapsed at `start` without one) — the
// selection's now, selected in `direction`.
fn select_new(scope: &mut v8::PinScope<'_, '_>, sel: &SelectionHandle, fresh: v8::Local<'_, v8::Object>, start: Point<'_>, end: Option<Point<'_>>, direction: u8) -> u32 {
    if !set_points(scope, fresh.into(), start, end) {
        return IGNORED;
    }
    sel.select(scope, Some(fresh), direction);
    CHANGED
}
// …from one point to another, whichever comes first, in their direction — collapsed at `to` where they are in
// different trees (setBaseAndExtent: at its anchor, `from`; extend: at its new focus, `to`).
fn select_between(scope: &mut v8::PinScope<'_, '_>, cid: i32, sel: &SelectionHandle, fresh: v8::Local<'_, v8::Object>, from: Point<'_>, to: Point<'_>, at_from: bool) -> u32 {
    let order = compare_points(realm(scope, cid), (from.1, from.2), (to.1, to.2));
    match order {
        None if at_from => select_new(scope, sel, fresh, from, None, FORWARD),
        None => select_new(scope, sel, fresh, to, None, FORWARD),
        Some(Ordering::Greater) => select_new(scope, sel, fresh, to, Some(from), BACKWARD),
        Some(_) => select_new(scope, sel, fresh, from, Some(to), FORWARD),
    }
}

// __dom.selectionCollapse(selection, fresh, node, nid, offset) -> what it came to: the range collapsed at the point (no
// direction) — a null node empties the selection.
fn selection_collapse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sel) = handle(scope, args.get(0)) else { return };
    let (Some(fresh), Some(point)) = (object_arg(&args, 1), point_arg(scope, &args, 2)) else {
        let changed = sel.range(scope).is_some();
        sel.select(scope, None, NONE);
        return rv.set_uint32(if changed { CHANGED } else { IGNORED });
    };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let outcome = match check_point(arena, (point.1, point.2)) {
        Some(error) => error,
        None if !in_document(arena, sel, point.1) => IGNORED,
        None => select_new(scope, sel, fresh, point, None, NONE),
    };
    rv.set_uint32(outcome);
}

// __dom.selectionCollapseTo(selection, fresh, end) -> what it came to: the range collapsed at its start (at its end,
// `end` true) — a new one, the old one a script may hold left as it was.
fn selection_collapse_to(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(fresh)) = (handle(scope, args.get(0)), object_arg(&args, 1)) else { return };
    let which = usize::from(args.get(2).boolean_value(scope));
    let cid = realm_id(scope, &args);
    let Some(s) = selected(scope, cid, sel) else { return rv.set_uint32(EMPTY) };
    let Some(node) = container_of(scope, sel, which) else { return rv.set_uint32(EMPTY) };
    let (nid, offset) = if which == 1 { s.end } else { s.start };
    let outcome = select_new(scope, sel, fresh, (node, nid, offset), None, NONE);
    rv.set_uint32(outcome);
}

// __dom.selectionExtend(selection, fresh, node, nid, offset) -> what it came to: the focus moved to the point, the anchor
// staying — the range from whichever comes first, or collapsed at the new focus where that is in another tree than the
// range.
fn selection_extend(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(fresh)) = (handle(scope, args.get(0)), object_arg(&args, 1)) else { return };
    let Some(to) = point_arg(scope, &args, 2) else { return };
    let cid = realm_id(scope, &args);
    if !in_document(realm(scope, cid), sel, to.1) {
        return rv.set_uint32(IGNORED);
    }
    let Some(s) = selected(scope, cid, sel) else { return rv.set_uint32(EMPTY) };
    if let Some(error) = check_point(realm(scope, cid), (to.1, to.2)) {
        return rv.set_uint32(error);
    }
    let Some(anchor) = container_of(scope, sel, usize::from(s.anchor_is_end())) else { return rv.set_uint32(EMPTY) };
    let (anchor_nid, anchor_offset) = s.anchor();
    let outcome = select_between(scope, cid, sel, fresh, (anchor, anchor_nid, anchor_offset), to, false);
    rv.set_uint32(outcome);
}

// __dom.selectionBaseAndExtent(selection, fresh, anchorNode, anchorNid, anchorOffset, focusNode, focusNid, focusOffset)
// -> what it came to: the range from the anchor to the focus, whichever comes first — the offsets checked first, then
// where the nodes are, and only then a doctype, as setting the range's points would refuse it; collapsed at the anchor
// where the two are in different trees (its start set at the focus, then its end at the anchor, in the other tree).
fn selection_base_and_extent(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(fresh)) = (handle(scope, args.get(0)), object_arg(&args, 1)) else { return };
    let (Some(anchor), Some(focus)) = (point_arg(scope, &args, 2), point_arg(scope, &args, 5)) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    if anchor.2 > node_length(arena, anchor.1) || focus.2 > node_length(arena, focus.1) {
        return rv.set_uint32(OFFSET);
    }
    if !in_document(arena, sel, anchor.1) || !in_document(arena, sel, focus.1) {
        return rv.set_uint32(IGNORED);
    }
    if let Some(error) = check_point(arena, (anchor.1, anchor.2)).or_else(|| check_point(arena, (focus.1, focus.2))) {
        return rv.set_uint32(error);
    }
    let outcome = select_between(scope, cid, sel, fresh, anchor, focus, true);
    rv.set_uint32(outcome);
}

// __dom.selectionSelectChildren(selection, fresh, node, nid) -> what it came to: the range around the node's children —
// a text node's are none, whatever its length — where it is in the document's own tree.
fn selection_select_children(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(fresh), Some(node)) = (handle(scope, args.get(0)), object_arg(&args, 1), object_arg(&args, 2)) else { return };
    let Some(nid) = nid_arg(scope, &args, 3) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    if arena.get(nid).is_some_and(|n| n.node_type() == 10) {
        return rv.set_uint32(DOCTYPE);
    }
    if Some(arena.root_of(nid)) != sel.document.get() {
        return rv.set_uint32(IGNORED);
    }
    let count = arena.child_count(nid, false);
    let outcome = select_new(scope, sel, fresh, (node, nid, 0), Some((node, nid, count)), FORWARD);
    rv.set_uint32(outcome);
}

// __dom.selectionAddRange(selection, range) -> what it came to: the range selected, by reference — a range of the
// document's own tree, and none where the selection has one that counts already.
fn selection_add_range(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(range)) = (handle(scope, args.get(0)), object_arg(&args, 1)) else { return };
    let Some([start, _]) = points(scope, range.into()) else { return };
    let cid = realm_id(scope, &args);
    let foreign = Some(realm(scope, cid).root_of(start.0)) != sel.document.get();
    if foreign || selected(scope, cid, sel).is_some_and(|s| s.counted) {
        return rv.set_uint32(IGNORED);
    }
    sel.select(scope, Some(range), FORWARD);
    rv.set_uint32(CHANGED);
}

// __dom.selectionRemoveRange(selection, range) -> what it came to: the selection emptied, where `range` is its range.
fn selection_remove_range(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sel) = handle(scope, args.get(0)) else { return };
    if !sel.range(scope).is_some_and(|r| r.strict_equals(args.get(1))) {
        return rv.set_uint32(NOT_FOUND);
    }
    sel.select(scope, None, NONE);
    rv.set_uint32(CHANGED);
}

// __dom.selectionContains(selection, nid, allowPartialContainment) -> whether the range holds all of the node — starts
// at or before its first boundary point, (node, 0), and ends at or after its last, (node, length) — or, allowing partial
// containment, any of it; false where either is out of the document's own tree.
fn selection_contains(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sel), Some(nid)) = (handle(scope, args.get(0)), nid_arg(scope, &args, 1)) else { return };
    let partial = args.get(2).boolean_value(scope);
    let cid = realm_id(scope, &args);
    let Some(s) = selected(scope, cid, sel).filter(|s| s.counted) else { return rv.set_bool(false) };
    let arena = realm(scope, cid);
    if Some(arena.root_of(nid)) != sel.document.get() {
        return rv.set_bool(false);
    }
    let length = node_length(arena, nid);
    let (first, last) = if partial { ((nid, length), (nid, 0)) } else { ((nid, 0), (nid, length)) };
    let starts_before = compare_points(arena, s.start, first).is_none_or(|o| o != Ordering::Greater);
    let ends_after = compare_points(arena, s.end, last).is_none_or(|o| o != Ordering::Less);
    rv.set_bool(starts_before && ends_after);
}

// __dom.selectionComposed(selection, [rootNid, …]) -> [startNode, startOffset, endNode, endOffset], or null for no
// selection: the range, as far out of shadow trees as it must go to be in the document or under one of the shadow roots
// named — a point in a shadow tree no given root is a shadow-including inclusive ancestor of moves to its host, before
// it for the start, after it for the end.
fn selection_composed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sel) = handle(scope, args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let Some(s) = selected(scope, cid, sel) else { return rv.set_null() };
    let given: Vec<NodeId> = crate::dom::nids_arg(scope, args.get(1));
    let arena = realm(scope, cid);
    let host = |root: NodeId| arena.get(root).and_then(|r| r.host);
    // (…whether a given root is `root` or in a shadow tree under it)
    let is_given = |root: NodeId| {
        given.iter().any(|&g| {
            let mut r = Some(g);
            while let Some(shadow) = r.filter(|&r| host(r).is_some()) {
                if shadow == root {
                    return true;
                }
                r = host(shadow).map(|h| arena.root_of(h));
            }
            false
        })
    };
    let rescope = |(mut node, mut offset): (NodeId, u32), after: bool| {
        loop {
            let root = arena.root_of(node);
            let Some(h) = host(root).filter(|_| !is_given(root)) else { break };
            let Some(parent) = arena.parent_of(h) else { break };
            node = parent;
            offset = arena.child_index(h) as u32 + u32::from(after);
        }
        (node, offset)
    };
    let (start, end) = (rescope(s.start, false), rescope(s.end, true));
    let start_node = crate::dom::node_value(scope, Some(start.0));
    let end_node = crate::dom::node_value(scope, Some(end.0));
    let start_offset = v8::Integer::new_from_unsigned(scope, start.1);
    let end_offset = v8::Integer::new_from_unsigned(scope, end.1);
    rv.set(v8::Array::new_with_elements(scope, &[start_node, start_offset.into(), end_node, end_offset.into()]).into());
}
