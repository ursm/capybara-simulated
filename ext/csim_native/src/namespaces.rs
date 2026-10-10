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

// ── names (DOM §1.5) ─────────────────────────────────────────────────────────────────────────────────────────────
// Each over UTF-16 units, a lone surrogate a code point past U+007F as any other.
fn code_points(name: &[u16]) -> impl Iterator<Item = u32> + '_ {
    char::decode_utf16(name.iter().copied()).map(|c| c.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from))
}
// ASCII whitespace, NUL, `/` and `>`: what a namespace prefix and an element's local name starting with a letter may not
// hold; an attribute's local name not `=` either, a doctype's name `/` it may.
fn forbidden(c: u32, extra: u32) -> bool {
    matches!(c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20 | 0x00 | 0x3E) || c == extra
}
// A valid namespace prefix: at least one code point, none forbidden.
pub(crate) fn valid_namespace_prefix(name: &[u16]) -> bool {
    !name.is_empty() && code_points(name).all(|c| !forbidden(c, 0x2F))
}
// A valid element local name: an ASCII letter followed by no forbidden code point; or `:`, `_` or past U+007F, followed
// by ASCII letters and digits, `-`, `.`, `:`, `_` and code points past U+007F.
pub(crate) fn valid_element_local_name(name: &[u16]) -> bool {
    let mut points = code_points(name);
    match points.next() {
        Some(c) if c < 0x80 && (c as u8).is_ascii_alphabetic() => points.all(|c| !forbidden(c, 0x2F)),
        Some(c) if c == 0x3A || c == 0x5F || c >= 0x80 => {
            points.all(|c| (c < 0x80 && (c as u8).is_ascii_alphanumeric()) || matches!(c, 0x2D | 0x2E | 0x3A | 0x5F) || c >= 0x80)
        }
        _ => false,
    }
}
// A valid attribute local name: at least one code point, none forbidden nor `=`.
pub(crate) fn valid_attribute_local_name(name: &[u16]) -> bool {
    !name.is_empty() && code_points(name).all(|c| !forbidden(c, 0x2F) && c != 0x3D)
}
// A valid doctype name: no ASCII whitespace, NUL or `>` (an empty one valid).
pub(crate) fn valid_doctype_name(name: &[u16]) -> bool {
    code_points(name).all(|c| !forbidden(c, u32::MAX))
}

// Whether `units` are the ASCII string `s`, unit for unit.
fn ascii_eq(units: &[u16], s: &str) -> bool {
    units.len() == s.len() && units.iter().zip(s.bytes()).all(|(&u, b)| u == u16::from(b))
}

// Why "validate and extract" refused a qualified name.
#[derive(Debug, PartialEq)]
pub(crate) enum NameError {
    Prefix,
    LocalName,
    NoNamespace,
    Xml,
    Xmlns,
    XmlnsReserved,
}
// DOM "validate and extract" `qualified` in `namespace` (an empty one none) for an element or, with `attribute`, an
// attribute: its namespace, prefix and local name.
pub(crate) fn validate_and_extract(namespace: Option<Vec<u16>>, qualified: &[u16], attribute: bool) -> Result<(Option<Vec<u16>>, Option<Vec<u16>>, Vec<u16>), NameError> {
    let namespace = namespace.filter(|n| !n.is_empty());
    let (prefix, local) = match qualified.iter().position(|&u| u == u16::from(b':')) {
        Some(at) => (Some(&qualified[..at]), &qualified[at + 1..]),
        None => (None, qualified),
    };
    if prefix.is_some_and(|p| !valid_namespace_prefix(p)) {
        return Err(NameError::Prefix);
    }
    if !(if attribute { valid_attribute_local_name(local) } else { valid_element_local_name(local) }) {
        return Err(NameError::LocalName);
    }
    let is = |ns: &Option<Vec<u16>>, uri: &str| ns.as_deref().is_some_and(|n| ascii_eq(n, uri));
    let xmlns_named = ascii_eq(qualified, "xmlns") || prefix.is_some_and(|p| ascii_eq(p, "xmlns"));
    if prefix.is_some() && namespace.is_none() {
        return Err(NameError::NoNamespace);
    }
    if prefix.is_some_and(|p| ascii_eq(p, "xml")) && !is(&namespace, XML_NS) {
        return Err(NameError::Xml);
    }
    if xmlns_named && !is(&namespace, XMLNS_NS) {
        return Err(NameError::Xmlns);
    }
    if is(&namespace, XMLNS_NS) && !xmlns_named {
        return Err(NameError::XmlnsReserved);
    }
    Ok((namespace, prefix.map(<[u16]>::to_vec), local.to_vec()))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "locateNamespace", locate_namespace_op, context_id);
    crate::dom::register(scope, ns, "locatePrefix", locate_prefix_op, context_id);
    crate::dom::register(scope, ns, "validName", valid_name_op, context_id);
    crate::dom::register(scope, ns, "validateAndExtract", validate_and_extract_op, context_id);
}

// __dom.validName(kind, name) -> whether `name` is a valid element local name (kind 0), attribute local name (1) or
// doctype name (2).
fn valid_name_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).int32_value(scope).unwrap_or(0);
    let name = utf16_arg(scope, args.get(1));
    rv.set_bool(match kind {
        0 => valid_element_local_name(&name),
        1 => valid_attribute_local_name(&name),
        _ => valid_doctype_name(&name),
    });
}

// __dom.validateAndExtract(namespace, qualifiedName, attribute) -> [namespace, prefix, localName] (`validate_and_extract`,
// null for none), or why it refused: 1 the prefix, 2 the local name, 3 a prefix with no namespace, 4 `xml` not in the
// XML namespace, 5 `xmlns` not in the XMLNS one, 6 the XMLNS namespace for another name.
fn validate_and_extract_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let namespace = (!args.get(0).is_null_or_undefined()).then(|| utf16_arg(scope, args.get(0)));
    let qualified = utf16_arg(scope, args.get(1));
    match validate_and_extract(namespace, &qualified, args.get(2).is_true()) {
        Ok((namespace, prefix, local)) => {
            let mut string = |units: Option<Vec<u16>>| -> v8::Local<'_, v8::Value> {
                match units {
                    Some(u) => crate::dom::utf16_value(scope, &u),
                    None => v8::null(scope).into(),
                }
            };
            let values = [string(namespace), string(prefix), string(Some(local))];
            rv.set(v8::Array::new_with_elements(scope, &values).into());
        }
        Err(e) => rv.set_int32(e as i32 + 1),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        units(s)
    }

    #[test]
    fn names() {
        assert!(valid_element_local_name(&u("div")) && valid_element_local_name(&u("a:b")) && valid_element_local_name(&u("é")));
        assert!(!valid_element_local_name(&u("")) && !valid_element_local_name(&u("1a")) && !valid_element_local_name(&u("a>")));
        assert!(!valid_element_local_name(&u("_a b")) && valid_element_local_name(&[0xD800]));
        assert!(valid_attribute_local_name(&u("data-x")) && !valid_attribute_local_name(&u("a=b")) && !valid_attribute_local_name(&u("")));
        assert!(valid_doctype_name(&u("")) && valid_doctype_name(&u("a/b")) && !valid_doctype_name(&u("a b")));
        let xmlns = Some(u(XMLNS_NS));
        assert_eq!(validate_and_extract(Some(u("")), &u("p:x"), false), Err(NameError::NoNamespace));
        assert_eq!(validate_and_extract(Some(u("urn:x")), &u("xml:x"), false), Err(NameError::Xml));
        assert_eq!(validate_and_extract(None, &u("xmlns"), true), Err(NameError::Xmlns));
        assert_eq!(validate_and_extract(xmlns.clone(), &u("x"), true), Err(NameError::XmlnsReserved));
        assert_eq!(validate_and_extract(xmlns.clone(), &u("xmlns:a"), true), Ok((xmlns, Some(u("xmlns")), u("a"))));
        assert_eq!(validate_and_extract(Some(u("urn:x")), &u(":a"), false), Err(NameError::Prefix));
    }
}
