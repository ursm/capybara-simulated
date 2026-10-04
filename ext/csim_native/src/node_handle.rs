// A DOM node's JS object is a WRAPPER of a garbage-collected handle on V8's C++ heap (cppgc), the Blink model: the
// object is made by `__dom.NodeBase` (dom-nodes.js `Node` extends it), wraps a `NodeHandle`, and the unified heap
// traces one through the other — so a node's handle lives exactly as long as V8 can reach its object, whatever the
// reference cycles through it.
//
// What the handle carries is the node's arena slot — when V8 collects the object it collects the handle, and the slot is
// freed: the job a JS FinalizationRegistry did, without a registration per node. A handle is dropped inside a
// collection, where the arena may be in use, so its slot is only queued (`Reclaim`, its isolate's) and freed at the next
// op that creates a node, which is where a freed slot is wanted again — and the TREE's edges, as the collector sees
// them: its parent, its first child and its next sibling (Blink's layout), written by the arena as its children change
// (`relink`), so a node is kept alive by the tree it is in the way its JS object's references once kept it.
//
// The handle does not lead back to its object yet. Traced from the handle, as Blink traces a wrapper, an object is a ROOT
// in every scavenge: V8 drops a young traced object only where it is an unmodified API object, and every node object
// carries its own state as properties (`_id`, `_parent`, …), so no node made and dropped could die young — measured, a
// node churn +11-18% and its heap 4x; a weak handle per node cost +10% too. A slot is found in the JS tree by its path
// instead (`RealmArena::path_from`) until a node's object is a bare wrapper, its state the engine's: then the trace can
// be droppable, and the tree keep its objects.

use std::cell::{Cell, RefCell, UnsafeCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use v8::cppgc::{GarbageCollected, Member, Visitor, WeakPersistent};

use crate::dom::NodeId;

// The wrapper tag `Object::wrap` / `unwrap` file the handle under.
const TAG: u16 = 1;

// What marks an object as a node's (its internal field 0): no other object carries this address.
static BRAND: u8 = 0;

pub(crate) struct NodeHandle {
    // The arena slot the node holds — which realm, which slot — or none yet; and the queue of the isolate whose arena
    // that is. A node registered afresh (another realm's tree, an arena reset) holds its new slot; the one it left was
    // freed then.
    realm: Cell<i32>,
    nid: Cell<Option<NodeId>>,
    reclaim: RefCell<Weak<Reclaim>>,
    parent: Edge,
    first: Edge,
    next: Edge,
    // The tree it owns outside its children: a host's shadow root, a `<template>`'s contents — whose root's `parent` is
    // its owner, the other way.
    owned: Edge,
}

unsafe impl GarbageCollected for NodeHandle {
    fn trace(&self, visitor: &mut Visitor) {
        self.parent.trace(visitor);
        self.first.trace(visitor);
        self.next.trace(visitor);
        self.owned.trace(visitor);
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"NodeHandle"
    }
}

impl Drop for NodeHandle {
    fn drop(&mut self) {
        // (…an isolate already disposed has no arena to free into: its queue is gone, and so is the push)
        if let (Some(nid), Some(queue)) = (self.nid.get(), self.reclaim.get_mut().upgrade()) {
            queue.slots.lock().unwrap_or_else(|e| e.into_inner()).push((self.realm.get(), nid));
            queue.pending.store(true, Ordering::Release);
        }
    }
}

// One edge of the tree, on the C++ heap: written on the main thread only (the arena's), through Member's own assignment
// — whose write barrier is what lets the collector mark concurrently while it changes.
struct Edge(UnsafeCell<Member<NodeHandle>>);

impl Edge {
    fn new() -> Edge {
        Edge(UnsafeCell::new(Member::empty()))
    }
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector reads the member as Member's barriers allow; nothing here hands out a reference.
        visitor.trace(unsafe { &*self.0.get() });
    }
    // Point it at `to`'s handle — none where `to` has none, or none any more.
    fn set(&self, to: Option<&Link>) {
        // SAFETY: the main thread, which alone writes edges; the assignment runs Member's write barrier.
        unsafe {
            match to.and_then(|l| l.0.as_ref()) {
                Some(w) => (*self.0.get()).set(w),
                None => NO_EDGE.with(|empty| (*self.0.get()).set(empty)),
            }
        }
    }
    fn get(&self) -> Option<&NodeHandle> {
        // SAFETY: an edge points at a handle the collector keeps alive while this handle is.
        unsafe { (*self.0.get()).get() }
    }
}

thread_local! {
    // The empty member an edge is cleared to, made once a thread rather than per clear.
    static NO_EDGE: Member<NodeHandle> = Member::empty();
}

// A node's handle as its arena slot holds it: weakly — the slot is freed when the handle is collected, never the other
// way round — cleared by the collector when it goes.
#[derive(Default)]
pub(crate) struct Link(Option<WeakPersistent<NodeHandle>>);

impl Link {
    fn handle(&self) -> Option<&NodeHandle> {
        self.0.as_ref().and_then(|w| w.get())
    }
}

// The arena's side: `parent`'s children are `kids`; from `from` on, each one's parent and next-sibling edges are
// rewritten, and the parent's first-child edge where `from` is 0. `link_of` finds a node's link.
pub(crate) fn relink<'a>(parent: Option<&'a Link>, kids: &[NodeId], from: usize, to: usize, link_of: impl Fn(NodeId) -> Option<&'a Link>) {
    let end = kids.len().min(to);
    let mut here = kids.get(from).and_then(|&k| link_of(k));
    if from == 0 {
        if let Some(p) = parent.and_then(Link::handle) {
            p.first.set(here);
        }
    }
    for i in from..end {
        let next = kids.get(i + 1).and_then(|&k| link_of(k));
        if let Some(h) = here.and_then(Link::handle) {
            h.parent.set(parent);
            h.next.set(next);
        }
        here = next;
    }
}
// …and a node out of its parent: no parent, no next sibling.
pub(crate) fn unlink(link: &Link) {
    if let Some(h) = link.handle() {
        h.parent.set(None);
        h.next.set(None);
    }
}
// …and an owner's tree outside its children (the arena's side): `owner` owns `owned`, or nothing.
pub(crate) fn own(owner: &Link, owned: Option<&Link>) {
    if let Some(h) = owner.handle() {
        h.owned.set(owned);
    }
}
// …and that tree's root, owned by `owner`, or by nothing.
pub(crate) fn owned_by(root: &Link, owner: Option<&Link>) {
    if let Some(h) = root.handle() {
        h.parent.set(owner);
    }
}
// What a node's handle says of the tree, for verify mode: its parent's, first child's, next sibling's and owned tree's
// slots, each with its realm (a slot is a realm's); and the realm of the node's own.
pub(crate) fn edges(link: &Link) -> Option<([Option<(i32, NodeId)>; 4], i32)> {
    let h = link.handle()?;
    let slot = |e: &Edge| e.get().and_then(|t| Some((t.realm.get(), t.nid.get()?)));
    Some(([slot(&h.parent), slot(&h.first), slot(&h.next), slot(&h.owned)], h.realm.get()))
}

// An isolate's slots of collected nodes, waiting to be freed: (realm, slot). Owned by its `Dom`, which the handles only
// point at weakly.
#[derive(Default)]
pub(crate) struct Reclaim {
    pending: AtomicBool,
    slots: Mutex<Vec<(i32, NodeId)>>,
}

// Free the queued slots in their realms' arenas (a slot a reset already recycled is declined by its generation, a dropped
// realm's by its absence). One atomic load when there are none.
pub(crate) fn reclaim(dom: &mut crate::dom::Dom) {
    if !dom.reclaim.pending.swap(false, Ordering::Acquire) {
        return;
    }
    let slots = std::mem::take(&mut *dom.reclaim.slots.lock().unwrap_or_else(|e| e.into_inner()));
    for (realm, nid) in slots {
        if let Some(arena) = dom.realms.get_mut(&realm) {
            arena.free_node(nid);
        }
    }
}

// The constructor `Node` makes its objects with (`__dom.NodeBase`): each one branded, and a wrapper of a fresh handle
// that holds no slot yet.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = NodeHandle {
        realm: Cell::new(0),
        nid: Cell::new(None),
        reclaim: RefCell::new(Weak::new()),
        parent: Edge::new(),
        first: Edge::new(),
        next: Edge::new(),
        owned: Edge::new(),
    };
    let heap = scope.get_cpp_heap().expect("NodeBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, NodeHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps — through the Proxy a `<form>` is (its target is the node's object) — or None for anything
// that is no node's object: the brand is checked first, as `unwrap` reads garbage from an object it never wrapped.
fn handle_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<v8::cppgc::UnsafePtr<NodeHandle>> {
    let value = match v8::Local::<v8::Proxy>::try_from(value) {
        Ok(proxy) => proxy.get_target(scope),
        Err(_) => value,
    };
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a NodeHandle under TAG; the handle lives while its
    // object does, which the caller holds.
    unsafe { v8::Object::unwrap::<TAG, NodeHandle>(scope, obj) }
}

// Bind the node `value` is the object of to slot `nid` of realm `realm` — a no-op for an object that is no node's (one
// made before `__dom` existed, the snapshot's bootstrap).
pub(crate) fn bind(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, realm: i32, nid: NodeId) {
    let Some(ptr) = handle_of(scope, value) else { return };
    // SAFETY: the handle lives while its object does, which the caller holds.
    let h = unsafe { ptr.as_ref() };
    let queue = Arc::downgrade(&crate::dom::dom(scope).reclaim);
    h.realm.set(realm);
    h.nid.set(Some(nid));
    *h.reclaim.borrow_mut() = queue;
    // …and the slot holds the handle (weakly), its edges in the tree written as the slot's are
    crate::dom::realm(scope, realm).set_link(nid, Link(Some(WeakPersistent::new(&ptr))));
}

// `__dom.NodeBase` for a realm: the constructor of the isolate's template, made once per isolate — none on an isolate
// without a C++ heap, whose nodes stay plain objects.
pub(crate) fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let template = match crate::dom::dom(scope).node_template.clone() {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "NodeBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).node_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}
