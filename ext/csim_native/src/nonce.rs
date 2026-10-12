// An element's [[CryptographicNonce]] (HTML §2.6.4 "nonce attributes"): what its `nonce` content attribute was set to
// — kept by the attribute's change steps (attributes.rs), carried over by its cloning steps (cloning.rs) — which the
// `nonce` IDL attribute reads and writes, and which stays when connecting the element hides the attribute (`hideNonce`).
// An element whose attribute was never written since it was made has none of its own: its attribute is its nonce.

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};

impl RealmArena {
    // `id`'s nonce: its slot, else its `nonce` attribute, else empty.
    fn nonce(&self, id: NodeId) -> Vec<u16> {
        match self.nonces.get(&id) {
            Some(nonce) => nonce.clone(),
            None => self.get(id).and_then(|n| n.plain_attr_units("nonce")).unwrap_or_default(),
        }
    }
    // …set.
    pub(crate) fn set_nonce(&mut self, id: NodeId, nonce: Vec<u16>) {
        self.nonces.insert(id, nonce);
    }
    // …`copy`'s, a clone of `source`: the source's.
    pub(crate) fn clone_nonce(&mut self, source: NodeId, copy: NodeId) {
        if let Some(nonce) = self.nonces.get(&source).cloned() {
            self.nonces.insert(copy, nonce);
        }
    }
}

// Whether connecting `n` hides its nonce: an element whose `nonce` attribute is not empty.
pub(crate) fn hides_nonce(n: &NodeData) -> bool {
    n.kind == NodeKind::Element && n.plain_attr("nonce").is_some_and(|v| !v.is_empty())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "nonce", nonce, context_id);
    crate::dom::register(scope, ns, "setNonce", set_nonce, context_id);
    crate::dom::register(scope, ns, "hideNonce", hide_nonce, context_id);
}

// The element of a node argument, and its realm.
fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<(NodeId, i32)> {
    let id = crate::node_handle::nid_of(scope, value)?;
    let cid = crate::dom::dom(scope).arena.get(id).filter(|n| n.kind == NodeKind::Element)?.realm;
    Some((id, cid))
}

// __dom.nonce(element) -> its nonce.
fn nonce(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let nonce = element(scope, args.get(0)).map(|(id, _)| crate::dom::dom(scope).arena.nonce(id)).unwrap_or_default();
    rv.set(crate::dom::utf16_value(scope, &nonce));
}

// __dom.setNonce(element, value) — its nonce set, its attribute left as it is.
fn set_nonce(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let value = crate::dom::utf16_arg(scope, args.get(1));
    crate::dom::realm(scope, cid).set_nonce(id, value);
}

// __dom.hideNonce(element) — an element with a nonce connected (HTML "becomes browsing-context connected"): its `nonce`
// attribute emptied, so no selector can read it, its nonce kept. The attribute is emptied quietly — no record, no
// reaction.
fn hide_nonce(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let arena = crate::dom::realm(scope, cid);
    let Some(key) = arena.get(id).filter(|n| hides_nonce(n)).and_then(|n| n.key_by_ns("", "nonce")).map(str::to_owned) else { return };
    let nonce = arena.nonce(id);
    arena.set_nonce(id, nonce);
    crate::dom::store_attribute(scope, cid, id, &key, Some(&[]), None);
}
