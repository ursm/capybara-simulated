// The DOM's namespace lookups over the arena's trees (DOM §4.4): "locate a namespace" (`lookupNamespaceURI`,
// `isDefaultNamespace`) and "locate a namespace prefix" (`lookupPrefix`) — an element's own namespace and prefix, and the
// `xmlns` attributes declaring one, from it up through its ancestor elements. Names and values are compared exactly, as
// UTF-16: a namespace or prefix may carry a lone surrogate.

use crate::dom::{nid_arg, realm_id, utf16_arg, NodeId, NodeKind, RealmArena};

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";

// The element a lookup on `id` starts at: itself, a document's document element, or the parent element of any other
// node — none for a doctype or a fragment.
fn start(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    match arena.get(id)?.kind {
        NodeKind::Element => Some(id),
        NodeKind::Document => arena.first_element_child(id),
        NodeKind::Other | NodeKind::Fragment => None,
        _ => parent_element(arena, id),
    }
}
fn parent_element(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    arena.parent_of(id).filter(|&p| arena.is_element(p))
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

// "Locate a namespace" for `prefix` (None for none) from `id`: the namespace (None for none).
fn locate_namespace(arena: &RealmArena, id: NodeId, prefix: Option<&[u16]>) -> Option<Vec<u16>> {
    let mut el = start(arena, id)?;
    // (…the legacy `xml` and `xmlns` bindings hold for every element)
    if prefix == Some(&units("xml")[..]) {
        return Some(units(XML_NS));
    }
    if prefix == Some(&units("xmlns")[..]) {
        return Some(units(XMLNS_NS));
    }
    let (xmlns, xmlns_ns) = (units("xmlns"), units(XMLNS_NS));
    loop {
        let n = arena.get(el)?;
        if !n.ns.is_empty() && n.prefix_is(prefix) {
            return Some(n.ns_units().into_owned());
        }
        // (…an `xmlns:prefix` attribute, or `xmlns` itself for no prefix: its value, and none where that is empty)
        let declared = n.namespaced_attributes().find(|(key, ns, local)| {
            *ns == xmlns_ns
                && match prefix {
                    Some(p) => key.starts_with("xmlns:") && **local == *p,
                    None => !key.contains(':') && **local == xmlns,
                }
        });
        if let Some((key, _, _)) = declared {
            return n.attr_units(key).filter(|v| !v.is_empty()).map(|v| v.into_owned());
        }
        el = parent_element(arena, el)?;
    }
}

// "Locate a namespace prefix" for `namespace` from `id`: an element's own prefix where its namespace is that, or the
// local name of an `xmlns:` attribute declaring it — the first, up from the element.
fn locate_prefix(arena: &RealmArena, id: NodeId, namespace: &[u16]) -> Option<Vec<u16>> {
    let mut el = start(arena, id)?;
    loop {
        let n = arena.get(el)?;
        if n.ns_is(namespace) {
            if let Some(p) = n.prefix_units() {
                return Some(p.into_owned());
            }
        }
        let declared = n.namespaced_attributes().find(|(key, _, _)| key.starts_with("xmlns:") && n.attr_units(key).is_some_and(|v| *v == *namespace));
        if let Some((_, _, local)) = declared {
            return Some(local.into_owned());
        }
        el = parent_element(arena, el)?;
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "locateNamespace", locate_namespace_op, context_id);
    crate::dom::register(scope, ns, "locatePrefix", locate_prefix_op, context_id);
}

// __dom.locateNamespace(nid, prefix) -> the namespace `prefix` (null for none) is bound to at the node, or null.
fn locate_namespace_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let prefix = (!args.get(1).is_null_or_undefined()).then(|| utf16_arg(scope, args.get(1)));
    let cid = realm_id(scope, &args);
    let found = locate_namespace(crate::dom::realm(scope, cid), id, prefix.as_deref());
    if let Some(s) = found.and_then(|units| v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal)) {
        rv.set(s.into());
    }
}

// __dom.locatePrefix(nid, namespace) -> a prefix `namespace` is bound to at the node, or null.
fn locate_prefix_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let namespace = utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let found = locate_prefix(crate::dom::realm(scope, cid), id, &namespace);
    if let Some(s) = found.and_then(|p| v8::String::new_from_two_byte(scope, &p, v8::NewStringType::Normal)) {
        rv.set(s.into());
    }
}
