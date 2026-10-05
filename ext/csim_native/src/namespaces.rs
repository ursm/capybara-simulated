// The DOM's namespace lookups over the arena's trees (DOM §4.4): "locate a namespace" (`lookupNamespaceURI`,
// `isDefaultNamespace`) and "locate a namespace prefix" (`lookupPrefix`) — an element's own namespace and prefix, and the
// `xmlns` attributes declaring one, from it up through its ancestor elements.
//
// (An element's namespace and prefix are the arena's, lossy UTF-8: one with a lone surrogate — no namespace a page
// declares to be found — compares as U+FFFD.)

use crate::dom::{nid_arg, realm_id, NodeId, NodeKind, RealmArena};

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

// "Locate a namespace" for `prefix` (None for none) from `id`: the namespace, as UTF-16 (None for none).
fn locate_namespace(arena: &RealmArena, id: NodeId, prefix: Option<&str>) -> Option<Vec<u16>> {
    // (…the legacy `xml` and `xmlns` bindings hold for every element)
    let mut el = start(arena, id)?;
    match prefix {
        Some("xml") => return Some(XML_NS.encode_utf16().collect()),
        Some("xmlns") => return Some(XMLNS_NS.encode_utf16().collect()),
        _ => {}
    }
    loop {
        let n = arena.get(el)?;
        if !n.ns.is_empty() && n.prefix.as_deref() == prefix {
            return Some(n.ns.encode_utf16().collect());
        }
        // (…an `xmlns:prefix` attribute, or `xmlns` itself for no prefix: its value, and none where that is empty)
        let declared = n.attribute_list().into_iter().find(|a| {
            a.ns.as_deref() == Some(XMLNS_NS)
                && match prefix {
                    Some(p) => a.prefix.as_deref() == Some("xmlns") && a.local == p,
                    None => a.prefix.is_none() && a.local == "xmlns",
                }
        });
        if let Some(a) = declared {
            return (!a.value.is_empty()).then_some(a.value);
        }
        el = parent_element(arena, el)?;
    }
}

// "Locate a namespace prefix" for `namespace` from `id`: an element's own prefix where its namespace is that, or the
// local name of an `xmlns:` attribute declaring it — the first, up from the element.
fn locate_prefix(arena: &RealmArena, id: NodeId, namespace: &[u16]) -> Option<String> {
    let mut el = start(arena, id)?;
    loop {
        let n = arena.get(el)?;
        if n.ns.encode_utf16().eq(namespace.iter().copied()) {
            if let Some(p) = &n.prefix {
                return Some(p.to_string());
            }
        }
        let declared = n.attribute_list().into_iter().find(|a| a.prefix.as_deref() == Some("xmlns") && a.value == namespace);
        if let Some(a) = declared {
            return Some(a.local);
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
    let prefix = (!args.get(1).is_null_or_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
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
    let namespace = crate::dom::utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let found = locate_prefix(crate::dom::realm(scope, cid), id, &namespace);
    if let Some(s) = found.and_then(|p| v8::String::new(scope, &p)) {
        rv.set(s.into());
    }
}
