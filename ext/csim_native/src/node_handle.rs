// A DOM node's JS object is a WRAPPER of a garbage-collected handle on V8's C++ heap (cppgc), the Blink model: the
// object is made by `__dom.NodeBase` (dom-nodes.js `Node` constructs through it), wraps a `NodeHandle`, and the
// unified heap traces one through the other — so a node's wrapper lives exactly as long as V8 can reach it, whatever
// the reference cycles through it.
//
// What the handle carries today is the node's arena slot: when V8 collects the wrapper it collects the handle, and the
// slot is freed — the job a JS FinalizationRegistry did, without a registration per node. A handle is dropped inside a
// collection, where the arena may be in use, so its slot is only queued (`Reclaim`) and freed at the next op that
// creates a node, which is where a freed slot is wanted again.

use std::cell::Cell;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use v8::cppgc::{GarbageCollected, GcCell, Visitor};

use crate::dom::NodeId;

// The wrapper tag `Object::wrap` / `unwrap` file the handle under.
const TAG: u16 = 1;

pub(crate) struct NodeHandle {
    // The arena slot the node holds — which `Dom` (isolate), which realm, which slot — or none yet. A node registered
    // afresh (another realm's tree, an arena reset) holds its new slot; the one it left was freed then.
    dom: Cell<u64>,
    realm: Cell<i32>,
    nid: Cell<Option<NodeId>>,
    wrapper: GcCell<v8::TracedReference<v8::Object>>,
}

unsafe impl GarbageCollected for NodeHandle {
    fn trace(&self, visitor: &mut Visitor) {
        visitor.trace(&self.wrapper);
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"NodeHandle"
    }
}

impl Drop for NodeHandle {
    fn drop(&mut self) {
        if let Some(nid) = self.nid.get() {
            RECLAIM.lock().unwrap_or_else(|e| e.into_inner()).push((self.dom.get(), self.realm.get(), nid));
        }
    }
}

// The slots of collected nodes, waiting to be freed: (Dom, realm, slot). Keyed by the `Dom` so a slot an isolate's
// last collection queues is never freed in another isolate's arena.
static RECLAIM: Mutex<Vec<(u64, i32, NodeId)>> = Mutex::new(Vec::new());
// …and each `Dom`'s key.
static NEXT_DOM: AtomicU64 = AtomicU64::new(1);
pub(crate) fn next_dom_key() -> u64 {
    NEXT_DOM.fetch_add(1, Ordering::Relaxed)
}

// Free the queued slots that are this `Dom`'s, in their realms' arenas (a slot a reset already recycled is declined by
// its generation, a dropped realm's by its absence).
pub(crate) fn reclaim(dom: &mut crate::dom::Dom) {
    let mine: Vec<(i32, NodeId)> = {
        let mut queue = RECLAIM.lock().unwrap_or_else(|e| e.into_inner());
        if queue.is_empty() {
            return;
        }
        let key = dom.key;
        let mut mine = Vec::new();
        queue.retain(|&(d, realm, nid)| {
            if d == key {
                mine.push((realm, nid));
            }
            d != key
        });
        mine
    };
    for (realm, nid) in mine {
        if let Some(arena) = dom.realms.get_mut(&realm) {
            arena.free_node(nid);
        }
    }
}

// The constructor `Node` makes its objects with (`__dom.NodeBase`): each one a wrapper of a fresh handle that holds
// no slot yet.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let handle = NodeHandle { dom: Cell::new(0), realm: Cell::new(0), nid: Cell::new(None), wrapper: GcCell::new(v8::TracedReference::new(scope, obj)) };
    let Some(heap) = scope.get_cpp_heap() else { return };
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, NodeHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps — through the Proxy a `<form>` is (its target is the wrapper) — or None for anything that is
// no node wrapper (`unwrap` reads garbage from a plain object, so the wrapper check comes first).
fn handle_of<'a>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'a NodeHandle> {
    let value = match v8::Local::<v8::Proxy>::try_from(value) {
        Ok(proxy) => proxy.get_target(scope),
        Err(_) => value,
    };
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.is_api_wrapper())?;
    // SAFETY: an API wrapper this module made carries a NodeHandle under TAG; the handle lives while its wrapper does,
    // which the caller holds.
    let ptr = unsafe { v8::Object::unwrap::<TAG, NodeHandle>(scope, obj) }?;
    Some(unsafe { &*(ptr.as_ref() as *const NodeHandle) })
}

// Bind the node `value` wraps to slot `nid` of realm `realm` — a no-op for an object that wraps no handle (one made
// before `__dom` existed, the snapshot's bootstrap). Whether it did.
pub(crate) fn bind(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, realm: i32, nid: NodeId) -> bool {
    let Some(h) = handle_of(scope, value) else { return false };
    h.dom.set(crate::dom::dom(scope).key);
    h.realm.set(realm);
    h.nid.set(Some(nid));
    true
}

// `__dom.NodeBase` for a realm: the constructor of the isolate's template, made once per isolate.
pub(crate) fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    let template = match crate::dom::dom(scope).node_template.clone() {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "NodeBase")?);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).node_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}
