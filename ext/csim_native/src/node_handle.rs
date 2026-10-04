// A DOM node's JS object is a WRAPPER of a garbage-collected handle on V8's C++ heap (cppgc), the Blink model: the
// object is made by `__dom.NodeBase` (dom-nodes.js `Node` extends it), wraps a `NodeHandle`, and the unified heap
// traces one through the other — so a node's handle lives exactly as long as V8 can reach its object, whatever the
// reference cycles through it.
//
// What the handle carries today is the node's arena slot: when V8 collects the object it collects the handle, and the
// slot is freed — the job a JS FinalizationRegistry did, without a registration per node. A handle is dropped inside a
// collection, where the arena may be in use, so its slot is only queued (`Reclaim`, its isolate's) and freed at the
// next op that creates a node, which is where a freed slot is wanted again.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use v8::cppgc::{GarbageCollected, Visitor};

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
}

unsafe impl GarbageCollected for NodeHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
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
    let handle = NodeHandle { realm: Cell::new(0), nid: Cell::new(None), reclaim: RefCell::new(Weak::new()) };
    let heap = scope.get_cpp_heap().expect("NodeBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, NodeHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps — through the Proxy a `<form>` is (its target is the node's object) — or None for anything
// that is no node's object: the brand is checked first, as `unwrap` reads garbage from an object it never wrapped.
fn handle_of<'a>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'a NodeHandle> {
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
    let ptr = unsafe { v8::Object::unwrap::<TAG, NodeHandle>(scope, obj) }?;
    Some(unsafe { &*(ptr.as_ref() as *const NodeHandle) })
}

// Bind the node `value` is the object of to slot `nid` of realm `realm` — a no-op for an object that is no node's (one
// made before `__dom` existed, the snapshot's bootstrap).
pub(crate) fn bind(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, realm: i32, nid: NodeId) {
    let Some(h) = handle_of(scope, value) else { return };
    let queue = Arc::downgrade(&crate::dom::dom(scope).reclaim);
    h.realm.set(realm);
    h.nid.set(Some(nid));
    *h.reclaim.borrow_mut() = queue;
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
