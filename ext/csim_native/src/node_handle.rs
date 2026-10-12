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
// The handle leads back to its object from the node's making (`object`, the one a script holds — a `<form>`'s or a
// `<select>`'s Proxy, a document's, once made: `setNodeObject`), so the engine can hand back any node's object —
// detached ones too (`nodes_value`, dom.rs). Traced from the handle, as Blink traces a wrapper, an object
// is a ROOT in every scavenge: V8 drops a young traced object only where it is an unmodified API object, and node
// objects still carry state of their own as properties, so no node made and dropped dies young — measured
// 2026-10-11: +13-16% on a churn microbench (200k createElement), ~1% on the app suites. The reference is DROPPABLE
// (src/v8_shim.cc): it holds an object with state of its own as a strong one does, and once a node's object is a bare
// wrapper, its state the engine's, a scavenge may drop it young (`csim_node_reset_root`), and the handle answers for it
// no more: an answer then holds null in its place, a dispatch falls back to the JS walk (making it anew is still to
// come). None does while a node object carries state of its own (measured 2026-10-11: not once across the spec suite).

use std::cell::{Cell, RefCell, UnsafeCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use v8::cppgc::{GarbageCollected, Member, Visitor, WeakPersistent};

use crate::dom::NodeId;

// The wrapper tag `Object::wrap` / `unwrap` file the handle under.
const TAG: u16 = 1;

// What marks an object as a node's (its internal field 0): no other object carries this address.
static BRAND: u8 = 0;

// src/v8_shim.cc: a DROPPABLE TracedReference, and the roots handler that resets one when a scavenge drops the young,
// unmodified wrapper it held — which every reference to a node's object is. While a node object carries its own state
// as properties no scavenge drops it, and a droppable reference holds it as a strong one does; once the object is a bare
// wrapper, its state the engine's, V8 may drop it and the handle make it anew (Blink's model).
unsafe extern "C" {
    fn csim_traced_reset_droppable(this: *mut v8::TracedReference<v8::Object>, isolate: v8::UnsafeRawIsolatePtr, other: *const v8::Object);
    fn csim_install_roots_handler(isolate: v8::UnsafeRawIsolatePtr, tag: u16);
    fn csim_traced_clear(this: *mut v8::TracedReference<v8::Object>);
}
// V8 dropped the wrapper of the handle `wrappable` (filed under TAG): its reference goes, and it holds its object no more.
#[unsafe(no_mangle)]
extern "C" fn csim_node_reset_root(wrappable: *mut std::ffi::c_void) {
    // SAFETY: the roots handler unwrapped this pointer under TAG, which only NodeHandles are wrapped under — the RustObj
    // header `Object::wrap` stored, not the handle: `UnsafePtr` finds the handle in it (a cast of the raw pointer wrote
    // into that header and left the reference V8 then zapped, which the next scavenge crashed on). V8 calls it on the
    // main thread, outside any borrow of the handle.
    let raw = wrappable as *mut _;
    let Some(ptr) = (unsafe { v8::cppgc::UnsafePtr::<NodeHandle>::new(&raw) }) else { return };
    let handle = unsafe { ptr.as_ref() };
    // SAFETY: as above; V8 resets the reference it reports dropped only through this call's embedder.
    unsafe { csim_traced_clear(handle.object.get()) };
}

pub(crate) struct NodeHandle {
    // The arena slot the node holds, or none yet; and the queue of the isolate whose arena that is. A node registered
    // afresh (another realm's tree, an arena reset) holds its new slot; the one it left was freed then.
    nid: Cell<Option<NodeId>>,
    reclaim: RefCell<Weak<Reclaim>>,
    parent: Edge,
    first: Edge,
    next: Edge,
    // The tree it owns outside its children: a host's shadow root, a `<template>`'s contents — whose root's `parent` is
    // its owner, the other way.
    owned: Edge,
    // Its object — the one a script holds (a `<form>`'s Proxy) — from its making; empty once V8 dropped a bare one.
    object: UnsafeCell<v8::TracedReference<v8::Object>>,
    // Its event listeners (events.js: type → list), once it has any — the node's state, not its object's
    // (`listenerStore`, and `listenerStores` for a dispatch's whole path in one call).
    listeners: UnsafeCell<v8::TracedReference<v8::Object>>,
    // The rest of what the bindings keep for it that is script objects, not the engine's data, made when first needed
    // (`rareData`, Blink's rare data): its [SameObject] collections and style declaration, a file input's files, the
    // string a control's live value was last given.
    rare: UnsafeCell<v8::TracedReference<v8::Object>>,
    // Its node document (DOM §4.4), the document object — none for a document itself, which is its own — that adoption
    // changes (`nodeDocument` / `setNodeDocument`): an Attr's too, which has no slot in the arena.
    document: UnsafeCell<v8::TracedReference<v8::Object>>,
    // A character data node's data as the string a script reads (`nodeData`) — or a form control's live value
    // (`liveValue`), an element having no data: the one it was last given, or the one made from the arena's the first
    // time it is read since — the arena's is the data, this is its string, kept so a read is no copy (a 200K-character
    // textarea's value read 5,000 times). Empty until either.
    data: UnsafeCell<v8::TracedReference<v8::String>>,
    // Its custom element registry (HTML: an element's, a shadow root's, a document's), as ce_reactions.rs codes it — none
    // set, the template contents' tracking null, the null registry, or a registry — kept here as the node document is,
    // whichever arena slot the node holds.
    registry: Cell<u32>,
    // …and, for a document with a browsing context, its window's registry (none for one without): what a node of it with
    // no registry set has.
    window_registry: Cell<u32>,
    // The registries those codes name, held: the engine's table holds them weakly, so a registry lives while a node is
    // associated with it — or a script holds it — and no longer.
    registry_object: UnsafeCell<v8::TracedReference<v8::Object>>,
    window_registry_object: UnsafeCell<v8::TracedReference<v8::Object>>,
    // …and, for a shadow root, whether it keeps its null registry as it is adopted (a declarative
    // `shadowrootcustomelementregistry` root's: HTML "keep custom element registry null").
    keep_null: Cell<bool>,
    // The realm whose code made a node the engine made (`bare`), whose factory makes its object (`object_of`).
    maker: Cell<i32>,
}

impl NodeHandle {
    pub(crate) fn registry(&self) -> u32 {
        self.registry.get()
    }
    // …`code`, which names `object` where it is a registry.
    pub(crate) fn set_registry(&self, scope: &mut v8::PinScope<'_, '_>, code: u32, object: Option<v8::Local<'_, v8::Object>>) {
        self.registry.set(code);
        // SAFETY: the main thread writes the reference, as TracedReference allows between marking steps.
        unsafe { (*self.registry_object.get()).reset(scope, object) };
    }
    // …a code with no registry of its own (none set, the tracking null), which an insertion moves between.
    pub(crate) fn set_registry_state(&self, code: u32) {
        self.registry.set(code);
    }
    pub(crate) fn keep_null(&self) -> bool {
        self.keep_null.get()
    }
    pub(crate) fn set_keep_null(&self, keep: bool) {
        self.keep_null.set(keep);
    }
    // Its node document becomes `doc`.
    pub(crate) fn set_document(&self, scope: &mut v8::PinScope<'_, '_>, doc: Option<v8::Local<'_, v8::Object>>) {
        // SAFETY: the main thread writes the reference, as TracedReference allows between marking steps.
        unsafe { (*self.document.get()).reset(scope, doc) };
    }
    pub(crate) fn window_registry(&self) -> u32 {
        self.window_registry.get()
    }
    pub(crate) fn set_window_registry(&self, scope: &mut v8::PinScope<'_, '_>, code: u32, object: Option<v8::Local<'_, v8::Object>>) {
        self.window_registry.set(code);
        // SAFETY: as above.
        unsafe { (*self.window_registry_object.get()).reset(scope, object) };
    }
    pub(crate) fn nid(&self) -> Option<NodeId> {
        self.nid.get()
    }
    // Its node document's object, where it has one.
    pub(crate) fn document<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        // SAFETY: the main thread writes the reference; the handle lives while the caller holds its object.
        unsafe { (*self.document.get()).get(scope) }
    }
}

unsafe impl GarbageCollected for NodeHandle {
    fn trace(&self, visitor: &mut Visitor) {
        self.parent.trace(visitor);
        self.first.trace(visitor);
        self.next.trace(visitor);
        self.owned.trace(visitor);
        // SAFETY: written on the main thread only, between collections' marking steps as TracedReference allows.
        visitor.trace(unsafe { &*self.object.get() });
        visitor.trace(unsafe { &*self.listeners.get() });
        visitor.trace(unsafe { &*self.rare.get() });
        visitor.trace(unsafe { &*self.document.get() });
        visitor.trace(unsafe { &*self.data.get() });
        visitor.trace(unsafe { &*self.registry_object.get() });
        visitor.trace(unsafe { &*self.window_registry_object.get() });
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"NodeHandle"
    }
}

impl Drop for NodeHandle {
    fn drop(&mut self) {
        // (…an isolate already disposed has no arena to free into: its queue is gone, and so is the push)
        if let (Some(nid), Some(queue)) = (self.nid.get(), self.reclaim.get_mut().upgrade()) {
            queue.slots.lock().unwrap_or_else(|e| e.into_inner()).push(nid);
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
    pub(crate) fn handle(&self) -> Option<&NodeHandle> {
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
// slots.
pub(crate) fn edges(link: &Link) -> Option<[Option<NodeId>; 4]> {
    let h = link.handle()?;
    let slot = |e: &Edge| e.get().and_then(|t| t.nid.get());
    Some([slot(&h.parent), slot(&h.first), slot(&h.next), slot(&h.owned)])
}

// An isolate's slots of collected nodes, waiting to be freed. Owned by its `Dom`, which the handles only
// point at weakly.
#[derive(Default)]
pub(crate) struct Reclaim {
    pending: AtomicBool,
    slots: Mutex<Vec<NodeId>>,
}

// Free the queued slots (one a reset already recycled is declined by its generation). One atomic load when there are
// none.
pub(crate) fn reclaim(dom: &mut crate::dom::Dom) {
    if !dom.reclaim.pending.swap(false, Ordering::Acquire) {
        return;
    }
    let slots = std::mem::take(&mut *dom.reclaim.slots.lock().unwrap_or_else(|e| e.into_inner()));
    for nid in slots {
        dom.arena.free_node(nid);
    }
}

// The constructor `Node` makes its objects with (`__dom.NodeBase`): each one branded, and a wrapper of a fresh handle
// that holds no slot yet — or, where a node the engine made waits for its object (`wrap_pending`, `object_of`), of that
// node's handle, its slot its own.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let pending = crate::dom::dom(scope).wrap_pending.take();
    // SAFETY: the handle is on the cppgc heap — a fresh one moved there, or a pending one its Persistent holds — and its
    // pointer goes straight into the wrapper, which traces it.
    unsafe {
        let held = match pending {
            Some(held) => held,
            None => {
                let heap = scope.get_cpp_heap().expect("NodeBase is installed only on an isolate with a C++ heap");
                v8::cppgc::Persistent::new(&v8::cppgc::make_garbage_collected(heap, fresh()))
            }
        };
        v8::Object::wrap::<TAG, NodeHandle>(scope, obj, &held);
        let h = held.get().expect("a handle its Persistent holds");
        csim_traced_reset_droppable(h.object.get(), scope.as_raw_isolate_ptr(), &*obj as *const v8::Object);
    }
}
// A handle with no slot, no tree, no object.
fn fresh() -> NodeHandle {
    NodeHandle {
        nid: Cell::new(None),
        reclaim: RefCell::new(Weak::new()),
        parent: Edge::new(),
        first: Edge::new(),
        next: Edge::new(),
        owned: Edge::new(),
        object: UnsafeCell::new(v8::TracedReference::empty()),
        listeners: UnsafeCell::new(v8::TracedReference::empty()),
        rare: UnsafeCell::new(v8::TracedReference::empty()),
        document: UnsafeCell::new(v8::TracedReference::empty()),
        data: UnsafeCell::new(v8::TracedReference::empty()),
        registry: Cell::new(0),
        window_registry: Cell::new(0),
        registry_object: UnsafeCell::new(v8::TracedReference::empty()),
        window_registry_object: UnsafeCell::new(v8::TracedReference::empty()),
        keep_null: Cell::new(false),
        maker: Cell::new(0),
    }
}

// The handle of a node the ENGINE made (`RealmArena::create`), which has no object until the page is handed it
// (`object_of`): bound to slot `nid`, its node document `doc`'s, made by realm `maker`'s code. The Persistent returned holds it while the engine holds
// the node — a collection in between would take it, held by nothing else yet; then the tree's edges hold it, once it is
// in one, and its object once it has one; and otherwise it is collected, and its slot freed, as any node's is.
pub(crate) fn bare(scope: &mut v8::PinScope<'_, '_>, nid: NodeId, doc: Option<v8::Local<'_, v8::Object>>, maker: i32) -> v8::cppgc::Persistent<NodeHandle> {
    let heap = scope.get_cpp_heap().expect("the engine makes nodes only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and held by the Persistent before anything else allocates.
    let held = unsafe { v8::cppgc::Persistent::new(&v8::cppgc::make_garbage_collected(heap, fresh())) };
    let h = held.get().expect("a handle its Persistent holds");
    h.set_document(scope, doc);
    h.maker.set(maker);
    attach(scope, &held, h, nid);
    held
}

// The handle `value` wraps — through the Proxy a `<form>` is (its target is the node's object) — or None for anything
// that is no node's object: the brand is checked first, as `unwrap` reads garbage from an object it never wrapped.
pub(crate) fn handle_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<v8::cppgc::UnsafePtr<NodeHandle>> {
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

// The slot of the node `value` is the object of, where it is one with a slot.
pub(crate) fn nid_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    let ptr = handle_of(scope, value)?;
    // SAFETY: the handle lives while its object does, which the caller holds.
    unsafe { ptr.as_ref() }.nid()
}

// Bind the node `value` is the object of to slot `nid` — a no-op for an object that is no node's.
pub(crate) fn bind(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, nid: NodeId) {
    let Some(ptr) = handle_of(scope, value) else { return };
    // SAFETY: the handle lives while its object does, which the caller holds.
    attach(scope, &ptr, unsafe { ptr.as_ref() }, nid);
}
// …the handle `ptr` points at (`h`) to slot `nid`: the slot holds it (weakly), its edges in the tree written as the
// slot's are, and it frees the slot when it goes.
fn attach(scope: &mut v8::PinScope<'_, '_>, ptr: &impl v8::cppgc::GetRustObj<NodeHandle>, h: &NodeHandle, nid: NodeId) {
    let queue = Arc::downgrade(&crate::dom::dom(scope).reclaim);
    h.nid.set(Some(nid));
    *h.reclaim.borrow_mut() = queue;
    crate::dom::dom(scope).arena.set_link(nid, Link(Some(WeakPersistent::new(ptr))));
}

// The object of the node in slot `id` — made by the node factory (`setNodeFactory`) of the realm whose code made it, the
// first time a node the engine made, which has none, is handed to the page: the factory makes an object of the node's
// interface, which `construct` makes the wrapper of the node's own handle. None for a node with no handle, or whose
// maker has no factory.
pub(crate) fn object_of<'s>(scope: &mut v8::PinScope<'s, '_>, id: NodeId) -> Option<v8::Local<'s, v8::Object>> {
    let n = crate::dom::dom(scope).arena.get(id)?;
    // (…a handle collected since its answer was asked for is none: no object is made for it)
    let link = n.link.0.as_ref().map(|w| v8::cppgc::Persistent::new(w)).filter(|p| p.get().is_some())?;
    let h = link.get()?;
    if let Some(object) = held_of(&link).and_then(|h| h.get(scope)) {
        return Some(object);
    }
    // (…by the realm whose code made the node — not whichever tree's edges it is in now: Chrome's)
    let realm = h.maker.get();
    let factory = crate::dom::dom(scope).factories.get(&realm).cloned()?.to_local(scope)?;
    let n = crate::dom::dom(scope).arena.get(id)?;
    // (…its name exact: the UTF-16 the DOM holds, a lone surrogate kept)
    let exact = n.name_u16.as_deref().map(|e| (e.local.clone(), e.ns.clone(), e.prefix.clone()));
    let (local, ns, prefix) = exact.unwrap_or_else(|| {
        let utf16 = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        (utf16(&n.local_name), utf16(&n.ns), n.prefix.as_deref().map(utf16))
    });
    let node_type = n.node_type();
    let string = |scope: &mut v8::PinScope<'s, '_>, units: &[u16]| v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal);
    let args: [v8::Local<'_, v8::Value>; 5] = [
        v8::Number::new(scope, id.to_f64()).into(),
        v8::Integer::new_from_unsigned(scope, node_type).into(),
        string(scope, &local)?.into(),
        string(scope, &ns)?.into(),
        match prefix {
            Some(p) => string(scope, &p)?.into(),
            None => v8::null(scope).into(),
        },
    ];
    crate::dom::dom(scope).wrap_pending = Some(link);
    let undefined = v8::undefined(scope).into();
    let made = factory.call(scope, undefined, &args);
    let d = crate::dom::dom(scope);
    d.wrap_pending = None;
    // (…a factory that threw — its exception the page's now — noted: no other is called before the op returns)
    d.factory_threw |= made.is_none();
    made.and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())
}
fn held_of(handle: &v8::cppgc::Persistent<NodeHandle>) -> Option<HeldObject> {
    handle.get().map(|h| HeldObject(h.object.get()))
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
            // (…and the isolate's roots handler, for the droppable references its handles hold their objects by)
            // SAFETY: the isolate is live, and keeps the handler for its life.
            unsafe { csim_install_roots_handler(scope.as_raw_isolate_ptr(), TAG) };
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).node_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

// What a dispatch asks before it asks for its path's listener stores: the event types a node has ever had a listener of,
// and a count of the stores and types nodes have gained (`listenersGen`, a view on one buffer each realm's bindings read
// without a call) — the isolate's, as a node's store is: a node adopted from a frame keeps its listeners, and a
// listener one realm adds is one any other's dispatch fires.
#[derive(Default)]
pub(crate) struct ListenerTypes {
    types: std::collections::HashSet<String>,
    gained: u32,
    view: Option<v8::SharedRef<v8::BackingStore>>,
}

impl ListenerTypes {
    fn gained(&mut self) {
        self.gained = self.gained.wrapping_add(1);
        if let Some(view) = &self.view {
            for (cell, byte) in view.iter().zip(self.gained.to_ne_bytes()) {
                cell.set(byte);
            }
        }
    }
}

pub(crate) fn install_listeners(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "listenerStore", listener_store, context_id);
    crate::dom::register(scope, ns, "listenerStores", listener_stores, context_id);
    crate::dom::register(scope, ns, "dispatchPath", dispatch_path, context_id);
    crate::dom::register(scope, ns, "noteListenerType", note_listener_type, context_id);
    crate::dom::register(scope, ns, "listenerTypeKnown", listener_type_known, context_id);
    crate::dom::register(scope, ns, "rareData", rare_data, context_id);
    crate::dom::register(scope, ns, "nodeData", node_data, context_id);
    crate::dom::register(scope, ns, "liveValue", live_value, context_id);
    crate::dom::register(scope, ns, "setLiveValue", set_live_value, context_id);
    crate::dom::register(scope, ns, "nodeDocument", node_document, context_id);
    crate::dom::register(scope, ns, "setNodeDocument", set_node_document, context_id);
    crate::dom::register(scope, ns, "setSubtreeDocument", set_subtree_document, context_id);
    let store = {
        let types = &mut crate::dom::dom(scope).arena.listener_types;
        let gained = types.gained;
        types.view.get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(gained.to_ne_bytes().to_vec()).make_shared()).clone()
    };
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Uint32Array::new(scope, buffer, 0, 1), v8::String::new(scope, "listenersGen")) {
        ns.set(scope, key.into(), view.into());
    }
}

// `__dom.listenerStore(node[, store])`: the node's listener store, or undefined for none; with `store`, it becomes that
// (an object) or none (anything else) — one gained, counted.
fn listener_store(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let slot = unsafe { ptr.as_ref() }.listeners.get();
    if args.length() > 1 {
        let store = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
        if store.is_some() {
            crate::dom::dom(scope).arena.listener_types.gained();
        }
        // SAFETY: the main thread writes the reference; the handle lives while the object, an argument, does.
        unsafe { (*slot).reset(scope, store) };
        return;
    }
    // SAFETY: as above.
    if let Some(store) = unsafe { (*slot).get(scope) } {
        rv.set(store.into());
    }
}

// `__dom.listenerStores(nodes)` -> each node's listener store at its index (undefined for none): a dispatch's whole
// path in one call.
fn listener_stores(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(nodes) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let undefined: v8::Local<v8::Value> = v8::undefined(scope).into();
    let stores: Vec<v8::Local<v8::Value>> = (0..nodes.length())
        .map(|i| {
            let node = nodes.get_index(scope, i)?;
            // SAFETY: the main thread writes the reference; the handle lives while its object, in the array, does.
            handle_of(scope, node).and_then(|ptr| unsafe { (*ptr.as_ref().listeners.get()).get(scope) }).map(Into::into)
        })
        .map(|store| store.unwrap_or(undefined))
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &stores).into());
}

// `__dom.rareData(node[, make])` -> the node's rare data record — made first, with `make`, where it has none; else
// undefined.
fn rare_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    let slot = unsafe { ptr.as_ref() }.rare.get();
    // SAFETY: the main thread writes the reference; the handle lives while the object, an argument, does.
    if let Some(record) = unsafe { (*slot).get(scope) } {
        return rv.set(record.into());
    }
    if args.get(1).is_true() {
        let null: v8::Local<v8::Value> = v8::null(scope).into();
        let record = v8::Object::with_prototype_and_properties(scope, null, &[], &[]);
        // SAFETY: as above.
        unsafe { (*slot).reset(scope, Some(record)) };
        rv.set(record.into());
    }
}

// `__dom.nodeData(node)` -> a character data node's data (`data`): the string it holds, or one made from the arena's and
// held.
fn node_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(s) = data_string(scope, args.get(0)) {
        rv.set(s.into());
    }
}
// …the character data of the node `node` is the object of, as the string its handle holds — made of the arena's code
// units, and held, where it holds none yet.
pub(crate) fn data_string<'s>(scope: &mut v8::PinScope<'s, '_>, node: v8::Local<'_, v8::Value>) -> Option<v8::Local<'s, v8::String>> {
    let ptr = handle_of(scope, node)?;
    // SAFETY: the handle lives while its object, which the caller holds, does; the main thread writes the reference.
    let h = unsafe { ptr.as_ref() };
    if let Some(s) = unsafe { (*h.data.get()).get(scope) } {
        return Some(s);
    }
    let units = h.nid.get().and_then(|id| crate::dom::dom(scope).arena.get(id).map(|n| n.data.clone())).unwrap_or_default();
    let s = v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal)?;
    // SAFETY: as above.
    unsafe { (*h.data.get()).reset(scope, Some(s)) };
    Some(s)
}
// …and a write of it: `data` (a string) is what the node holds now — or, `appended`, what was appended to it — the slot
// whose data the caller writes answered, none for a node that has none yet (a CharacterData's constructor writes its data
// before its slot is made, which takes it from here: `registerNativeNode`).
// …or none: the node's data spliced in the arena, which a read makes the string of again (`data_string`).
pub(crate) fn forget_data(scope: &mut v8::PinScope<'_, '_>, node: v8::Local<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, node) else { return };
    // SAFETY: as `node_data`.
    unsafe { (*ptr.as_ref().data.get()).reset(scope, None) };
}
pub(crate) fn wrote_data(scope: &mut v8::PinScope<'_, '_>, node: v8::Local<'_, v8::Value>, data: v8::Local<'_, v8::String>, appended: bool) -> Option<NodeId> {
    let ptr = handle_of(scope, node)?;
    // SAFETY: as `node_data`.
    let h = unsafe { ptr.as_ref() };
    let held = if appended { unsafe { (*h.data.get()).get(scope) }.and_then(|s| v8::String::concat(scope, s, data)) } else { Some(data) };
    // SAFETY: as above.
    unsafe { (*h.data.get()).reset(scope, held) };
    h.nid.get()
}

// `__dom.liveValue(control)` -> a form control's live value — undefined while it is its default (no dirty value) — as
// the string its handle holds, made of the arena's units where it holds none.
fn live_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    // SAFETY: the handle lives while its object, an argument, does; the main thread writes the reference.
    let h = unsafe { ptr.as_ref() };
    let Some(units) = h.nid.get().and_then(|id| crate::dom::dom(scope).arena.get(id)).map(|n| n.value.as_ref().map(|v| v.len())) else { return };
    if units.is_none() {
        return;
    }
    if let Some(s) = unsafe { (*h.data.get()).get(scope) } {
        return rv.set(s.into());
    }
    let units = h.nid.get().and_then(|id| crate::dom::dom(scope).arena.get(id)?.value.clone()).unwrap_or_default();
    let Some(s) = v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal) else { return };
    // SAFETY: as above.
    unsafe { (*h.data.get()).reset(scope, Some(s)) };
    rv.set(s.into());
}
// `__dom.setLiveValue(control, value)` -> whether it changed: the live value becomes `value` (a string; undefined back
// to the default), the string held as given.
fn set_live_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return rv.set_bool(false) };
    // SAFETY: as `live_value`.
    let h = unsafe { ptr.as_ref() };
    let Some(id) = h.nid.get() else { return rv.set_bool(false) };
    let value = v8::Local::<v8::String>::try_from(args.get(1)).ok();
    let units = value.map(|s| {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        units.into_boxed_slice()
    });
    // (…in the control's realm, whatever realm's code writes it: its style state is what the value moves)
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return rv.set_bool(false) };
    if !crate::dom::realm(scope, cid).write_live_value(id, units) {
        return rv.set_bool(false);
    }
    // SAFETY: as above.
    unsafe { (*h.data.get()).reset(scope, value) };
    rv.set_bool(true);
}
// …and one the engine wrote, the units the arena has now: the string made of them when next read.
pub(crate) fn forget_live_value(scope: &mut v8::PinScope<'_, '_>, control: v8::Local<'_, v8::Value>) {
    forget_data(scope, control);
}

// `__dom.nodeDocument(node)` -> its node document, null for none — undefined for an object with no handle (an
// author's `Object.create(Node.prototype)`), which keeps its own.
fn node_document(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return };
    // SAFETY: the main thread writes the reference; the handle lives while the object, an argument, does.
    match unsafe { (*ptr.as_ref().document.get()).get(scope) } {
        Some(doc) => rv.set(doc.into()),
        None => rv.set_null(),
    }
}
// `__dom.setNodeDocument(node, doc)` -> whether the node has a handle to keep it: its node document becomes `doc` (none
// for anything but an object).
fn set_node_document(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ptr) = handle_of(scope, args.get(0)) else { return rv.set_bool(false) };
    let doc = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    // SAFETY: as above.
    unsafe { (*ptr.as_ref().document.get()).reset(scope, doc) };
    rv.set_bool(true);
}

// `__dom.setSubtreeDocument(rootNid, doc)`: the node document of the root and of every node of its tree under it (not a
// shadow tree's, nor a template's contents) becomes `doc` — a document's own subtree re-owned in one call.
fn set_subtree_document(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let doc = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    // (…the handles found first, while the arena is borrowed: setting a reference allocates nothing a collection could
    // take one in)
    let handles: Vec<*const NodeHandle> = {
        let arena = &crate::dom::dom(scope).arena;
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = arena.get(id) else { continue };
            out.extend(n.link.handle().map(|h| h as *const NodeHandle));
            stack.extend(n.children.iter().copied());
        }
        out
    };
    for h in handles {
        // SAFETY: the handles live while their nodes do, which the arena holds linked under `root`; the main thread
        // writes the reference.
        unsafe { (*(*h).document.get()).reset(scope, doc) };
    }
}

// `__dom.dispatchPath(targetNid)` -> [path, stores] for a dispatch at a node: the target and its ancestors up to its
// root, their objects — made for the nodes the engine made that have none — and each one's listener store (undefined
// for none); undefined where a node of it still has no object, which the bindings' own walk then answers; null where the path crosses a shadow root, which the flat
// tree's event path (event_path.rs) retargets across.
fn dispatch_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = crate::dom::nid_arg(scope, &args, 0) else { return };
    // (…the objects of the nodes the engine made made first — a clone's ancestors the page never asked for — before any
    // handle is read: making one runs script)
    let chain: Vec<(NodeId, Option<HeldObject>)> = {
        let arena = &crate::dom::dom(scope).arena;
        let mut out = Vec::new();
        let mut cur = Some(target);
        while let Some(id) = cur {
            let Some(n) = arena.get(id) else { break };
            out.push((id, held(&n.link)));
            cur = arena.parent_of(id);
        }
        out
    };
    let bare: Vec<NodeId> = chain.iter().filter(|(_, h)| h.as_ref().is_some_and(|h| h.get(scope).is_none())).map(|&(id, _)| id).collect();
    for id in bare {
        object_of(scope, id);
    }
    // (…the handles found next, while the arena is borrowed: reading the references allocates nothing a collection
    // could take one in until they are all read)
    let handles: Option<Vec<*const NodeHandle>> = {
        let arena = &crate::dom::dom(scope).arena;
        let mut out = Vec::new();
        let mut cur = Some(target);
        let mut whole = true;
        while let Some(id) = cur.filter(|_| whole) {
            let Some(n) = arena.get(id) else { break };
            if n.host.is_some() {
                return rv.set_null();
            }
            match n.link.handle() {
                Some(h) => out.push(h as *const NodeHandle),
                None => whole = false,
            }
            cur = arena.parent_of(id);
        }
        whole.then_some(out)
    };
    let Some(handles) = handles else { return };
    let undefined: v8::Local<v8::Value> = v8::undefined(scope).into();
    let mut path = Vec::with_capacity(handles.len());
    let mut stores = Vec::with_capacity(handles.len());
    for &h in &handles {
        // SAFETY: a handle's object is alive while its reference holds it; the main thread wrote the references.
        let Some(object) = (unsafe { (*(*h).object.get()).get(scope) }) else { return };
        path.push(object.into());
        stores.push(unsafe { (*(*h).listeners.get()).get(scope) }.map_or(undefined, Into::into));
    }
    let path = v8::Array::new_with_elements(scope, &path).into();
    let stores = v8::Array::new_with_elements(scope, &stores).into();
    rv.set(v8::Array::new_with_elements(scope, &[path, stores]).into());
}

// `__dom.noteListenerType(type)`: a node has a listener of `type` — a type none had before, counted.
fn note_listener_type(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    let types = &mut crate::dom::dom(scope).arena.listener_types;
    if types.types.insert(ty) {
        types.gained();
    }
}

// `__dom.listenerTypeKnown(type)` -> whether a node has ever had a listener of `type`.
fn listener_type_known(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(crate::dom::dom(scope).arena.listener_types.types.contains(&ty));
}

// `__dom.setNodeObject(object)`: the object a script holds for the node becomes `object` — the Proxy a `<form>`, a
// `<select>` or a document is made into once its node is (the target the handle wraps).
pub(crate) fn set_node_object(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let value = args.get(0);
    let (Some(ptr), Ok(obj)) = (handle_of(scope, value), v8::Local::<v8::Object>::try_from(value)) else { return };
    // SAFETY: the handle lives while its object does, an argument; the main thread writes the reference.
    unsafe { csim_traced_reset_droppable(ptr.as_ref().object.get(), scope.as_raw_isolate_ptr(), &*obj as *const v8::Object) };
}
// Where the object of the node whose handle `link` is lies — read with the scope once the arena is let go
// (`HeldObject::get`), and before anything is allocated on the JS heap (a collection in between could take the handle).
pub(crate) fn held(link: &Link) -> Option<HeldObject> {
    link.handle().map(|h| HeldObject(h.object.get()))
}
pub(crate) struct HeldObject(*const v8::TracedReference<v8::Object>);

impl HeldObject {
    pub(crate) fn get<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        // SAFETY: as `held` says — the handle has not been collected since.
        unsafe { (*self.0).get(scope) }
    }
}
