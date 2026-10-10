// Live NodeIterators (DOM §6.1): where each is — its reference, whether it is before it, and the working pointers of the
// traversals running on it while their filters do — kept here, and the "NodeIterator pre-removing steps" every removal
// runs on them (§4.2.3), over every live iterator of the isolate, wherever its tree.
//
// An iterator's state is the engine's, named by a handle on V8's C++ heap (`__dom.NodeIteratorBase`, as a range's is:
// ranges.rs) that the iterator's slots hold. What keeps its nodes alive is the root its slots hold too: the reference is
// always in the root's tree, every node of which the tree's edges keep (node_handle.rs). A collected iterator's entry is
// freed at the next op on iterators.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use v8::cppgc::{GarbageCollected, Visitor};

use crate::dom::{nid_arg, NodeId, RealmArena};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, a range's 2).
const TAG: u16 = 3;

// What marks an object as an iterator's handle (its internal field 0).
static BRAND: u8 = 0;

pub(crate) struct IteratorHandle {
    // The iterator's entry (`Iterators::entries`), or none until it is set up; and the queue of the isolate's iterators.
    id: Cell<Option<u32>>,
    dead: RefCell<Weak<Dead>>,
}

unsafe impl GarbageCollected for IteratorHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"IteratorHandle"
    }
}

impl Drop for IteratorHandle {
    fn drop(&mut self) {
        if let (Some(id), Some(dead)) = (self.id.get(), self.dead.get_mut().upgrade()) {
            dead.ids.lock().unwrap_or_else(|e| e.into_inner()).push(id);
            dead.pending.store(true, Ordering::Release);
        }
    }
}

// The entries of the iterators V8 collected, to be freed.
#[derive(Default)]
pub(crate) struct Dead {
    pending: AtomicBool,
    ids: Mutex<Vec<u32>>,
}

// A pointer into a tree: the node, and whether it is before it.
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Pointer {
    pub(crate) node: NodeId,
    pub(crate) before: bool,
}

struct Entry {
    root: NodeId,
    reference: Pointer,
    // The pointers of the traversals running on it, innermost last: the node each handed its filter, which a removal
    // while the filter runs moves as it moves the reference.
    working: Vec<Pointer>,
}

#[derive(Default)]
pub(crate) struct Iterators {
    entries: Vec<Option<Entry>>,
    free: Vec<u32>,
    live: usize,
    dead: Arc<Dead>,
    template: Option<v8::Global<v8::FunctionTemplate>>,
}

impl Iterators {
    // Free the entries of collected iterators. One atomic load when there are none.
    fn sweep(&mut self) {
        if !self.dead.pending.swap(false, Ordering::Acquire) {
            return;
        }
        let ids = std::mem::take(&mut *self.dead.ids.lock().unwrap_or_else(|e| e.into_inner()));
        for id in ids {
            if self.entries.get_mut(id as usize).and_then(Option::take).is_some() {
                self.free.push(id);
                self.live -= 1;
            }
        }
    }
    fn add(&mut self, entry: Entry) -> u32 {
        self.live += 1;
        match self.free.pop() {
            Some(id) => {
                self.entries[id as usize] = Some(entry);
                id
            }
            None => {
                self.entries.push(Some(entry));
                self.entries.len() as u32 - 1
            }
        }
    }
    fn entry(&mut self, id: u32) -> Option<&mut Entry> {
        self.entries.get_mut(id as usize)?.as_mut()
    }
    // The pre-removing steps `step` answers for each pointer of each live iterator, run.
    fn pre_remove(&mut self, step: impl Fn(NodeId, Pointer) -> Option<Pointer>) {
        self.sweep();
        for e in self.entries.iter_mut().flatten() {
            for w in &mut e.working {
                if let Some(p) = step(e.root, *w) {
                    *w = p;
                }
            }
            if let Some(p) = step(e.root, e.reference) {
                e.reference = p;
            }
        }
    }
}

// The isolate's iterators.
fn iterators<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Iterators {
    &mut crate::dom::dom(scope).iterators
}

// The NodeIterator pre-removing steps for the removal of `removed`, over every live iterator — before it leaves its
// parent. Nothing where there is none.
pub(crate) fn removing(scope: &mut v8::PinScope<'_, '_>, cid: i32, removed: NodeId) {
    if iterators(scope).live == 0 {
        return;
    }
    let d = crate::dom::dom(scope);
    let arena: &RealmArena = d.arena.enter(cid);
    d.iterators.pre_remove(|root, p| crate::traversal::pre_remove(arena, removed, root, p));
}

// The constructor an iterator's handle is made with (`__dom.NodeIteratorBase`): branded, and a wrapper of a fresh one.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let dead = Arc::downgrade(&iterators(scope).dead);
    let handle = IteratorHandle { id: Cell::new(None), dead: RefCell::new(dead) };
    let heap = scope.get_cpp_heap().expect("NodeIteratorBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, IteratorHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no iterator handle (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn handle_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<v8::cppgc::UnsafePtr<IteratorHandle>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped an IteratorHandle under TAG.
    unsafe { v8::Object::unwrap::<TAG, IteratorHandle>(scope, obj) }
}
// …and its entry's id.
fn entry_id(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<u32> {
    let ptr = handle_of(scope, value)?;
    // SAFETY: the handle lives while its wrapper does, which the caller holds.
    unsafe { ptr.as_ref() }.id.get()
}

// `__dom.NodeIteratorBase`: the constructor of the isolate's template, made once per isolate.
pub(crate) fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let template = match iterators(scope).template.clone() {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "NodeIteratorBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            iterators(scope).template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "iteratorInit", iterator_init, context_id);
    register(scope, ns, "iteratorReference", iterator_reference, context_id);
    register(scope, ns, "iteratorBefore", iterator_before, context_id);
    register(scope, ns, "iteratorsRemovingAll", iterators_removing_all, context_id);
    register(scope, ns, "iteratorsLive", iterators_live, context_id);
}

// __dom.iteratorsLive() -> how many live NodeIterators the isolate keeps (those V8 collected freed first).
fn iterators_live(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = iterators(scope);
    store.sweep();
    rv.set_uint32(store.live as u32);
}

// __dom.iteratorInit(handle, rootNid): the iterator `handle` is of starts at its root, before it.
fn iterator_init(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 1) else { return };
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    // SAFETY: the handle lives while its wrapper does, which the caller holds.
    let handle = unsafe { ptr.as_ref() };
    if handle.id.get().is_some() {
        return;
    }
    let store = iterators(scope);
    store.sweep();
    let start = Pointer { node: root, before: true };
    let id = store.add(Entry { root, reference: start, working: Vec::new() });
    handle.id.set(Some(id));
}

// __dom.iteratorReference(handle) -> its reference node (`referenceNode`), as `node_value` answers it.
fn iterator_reference(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = entry_id(scope, args.get(0)) else { return };
    let node = iterators(scope).entry(id).map(|e| e.reference.node);
    rv.set(crate::dom::node_value(scope, node));
}

// __dom.iteratorBefore(handle) -> whether it is before its reference (`pointerBeforeReferenceNode`).
fn iterator_before(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = entry_id(scope, args.get(0)) else { return };
    let before = iterators(scope).entry(id).is_some_and(|e| e.reference.before);
    rv.set_bool(before);
}

// __dom.iteratorsRemovingAll(parentNid): the pre-removing steps for the removal of every child of the parent, one after
// another, over every live iterator.
fn iterators_removing_all(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    if iterators(scope).live == 0 {
        return;
    }
    let cid = crate::dom::realm_id(scope, &args);
    let d = crate::dom::dom(scope);
    let arena: &RealmArena = d.arena.enter(cid);
    d.iterators.pre_remove(|root, p| crate::traversal::pre_remove_all(arena, parent, root, p));
}

// A traversal on the iterator `handle` is: where it starts (its reference), its root — and, around each call of its
// filter, the working pointer at the node handed to it, and where a removal while the filter ran moved that pointer.
pub(crate) fn traversal_start(scope: &mut v8::PinScope<'_, '_>, handle: v8::Local<'_, v8::Value>) -> Option<(u32, NodeId, Pointer)> {
    let id = entry_id(scope, handle)?;
    let store = iterators(scope);
    store.sweep();
    let e = store.entry(id)?;
    Some((id, e.root, e.reference))
}
pub(crate) fn push_working(scope: &mut v8::PinScope<'_, '_>, id: u32, at: Pointer) {
    if let Some(e) = iterators(scope).entry(id) {
        e.working.push(at);
    }
}
pub(crate) fn pop_working(scope: &mut v8::PinScope<'_, '_>, id: u32) -> Option<Pointer> {
    iterators(scope).entry(id)?.working.pop()
}
// …and where the traversal leaves it: its reference then.
pub(crate) fn traversal_end(scope: &mut v8::PinScope<'_, '_>, id: u32, at: Pointer) {
    if let Some(e) = iterators(scope).entry(id) {
        e.reference = at;
    }
}
