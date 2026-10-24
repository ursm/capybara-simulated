// An element's attribute list (DOM §4.9): finding an attribute by its qualified name or by its namespace and local name,
// and changing, appending, removing and replacing one — "handle attribute changes" with it: the mutation record queued,
// the attributeChangedCallback reaction enqueued, and the element's attribute change steps that are the engine's run
// (an input's type change). The arena stores the list (dom.rs `NodeData::attributes`), each attribute under a KEY: its
// qualified name, or — where two share one, in different namespaces — that name with a `\0` and a number after it; an
// attribute in a namespace carries a record of it and its local name (`attr_ns`). What the bindings still do for a
// change — a script prepared, a sheet renewed, a handler compiled, a frame navigated, an image fetched — the op answers
// as `STEP_*` bits.

use crate::dom::{realm, realm_id, NodeData, NodeId, RealmArena, STATE_CUSTOM, STATE_XML_DOCUMENT};
use crate::namespaces::{valid_attribute_local_name, validate_and_extract};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "attrKey", attr_key, context_id);
    crate::dom::register(scope, ns, "attrGet", attr_get, context_id);
    crate::dom::register(scope, ns, "attrNames", attr_names, context_id);
    crate::dom::register(scope, ns, "attrMapNames", attr_map_names, context_id);
    crate::dom::register(scope, ns, "attrMapNamed", attr_map_named, context_id);
    crate::dom::register(scope, ns, "datasetAttr", dataset_attr_op, context_id);
    crate::dom::register(scope, ns, "datasetNames", dataset_names_op, context_id);
    crate::dom::register(scope, ns, "attrName", attr_name, context_id);
    crate::dom::register(scope, ns, "attrWrite", attr_write, context_id);
}

// The arena's node `id`.
fn node_of<'a>(scope: &'a mut v8::PinScope<'_, '_>, id: NodeId) -> Option<&'a NodeData> {
    crate::dom::dom(scope).arena.get(id)
}
// A string of `units`, or null for none.
fn units_or_null<'s>(scope: &mut v8::PinScope<'s, '_>, units: Option<&[u16]>) -> v8::Local<'s, v8::Value> {
    match units {
        Some(u) => crate::dom::utf16_value(scope, u),
        None => v8::null(scope).into(),
    }
}
// The qualified name of the attribute stored under `key`.
fn qualified(key: &str) -> &str {
    key.split('\0').next().unwrap_or(key)
}
// …and its namespace (empty for none), prefix and local name.
fn name_of<'a>(n: &'a NodeData, key: &'a str) -> (&'a str, Option<&'a str>, &'a str) {
    let (ns, local) = n.attribute_name(key);
    let prefix = qualified(key).strip_suffix(local).and_then(|p| p.strip_suffix(':')).filter(|p| !p.is_empty() && !ns.is_empty());
    (ns, prefix, local)
}

impl NodeData {
    // DOM "get an attribute by name": the key of the first attribute whose qualified name is `name`.
    fn key_by_qname(&self, name: &str) -> Option<&str> {
        // (…its key the name, or the name numbered: compared without splitting each key)
        let named = |k: &str| k.len() >= name.len() && k.starts_with(name) && k.as_bytes().get(name.len()).is_none_or(|&b| b == 0);
        self.attributes.iter().map(|(k, _)| k.as_str()).find(|k| named(k))
    }
    // …"by namespace and local name": `ns` empty for none.
    pub(crate) fn key_by_ns(&self, ns: &str, local: &str) -> Option<&str> {
        self.attributes.iter().map(|(k, _)| k.as_str()).find(|k| self.attribute_name(k) == (ns, local))
    }
    // A key no attribute has for a new one named `qn`: the name itself where it is free — never for one in a namespace
    // with no prefix (`namespaced`), whose bare name every reflection reads as the attribute in NO namespace (Chrome's
    // `input.type` stays "text" beside a `urn:x` `type`) — else the name with a number.
    fn fresh_key(&self, qn: &str, namespaced: bool) -> String {
        if !namespaced && self.get_attr(qn).is_none() {
            return qn.to_owned();
        }
        (1..).map(|i| format!("{qn}\0{i}")).find(|k| self.get_attr(k).is_none()).unwrap_or_default()
    }
}

// Whether names given `id` are ASCII-lowercased: an HTML element's in an HTML document (DOM "get an attribute by name",
// "set an attribute value" via `setAttribute`) — its node document asked only where `name` has an uppercase letter.
fn lowered(scope: &mut v8::PinScope<'_, '_>, id: NodeId, mut name: String) -> String {
    if !name.bytes().any(|b| b.is_ascii_uppercase()) || !crate::dom::dom(scope).arena.get(id).is_some_and(NodeData::is_html) {
        return name;
    }
    let doc = crate::editing::document_of(scope, id).and_then(|d| crate::node_handle::nid_of(scope, d.into()));
    if !doc.and_then(|d| crate::dom::dom(scope).arena.get(d)).is_some_and(|d| d.state & STATE_XML_DOCUMENT != 0) {
        name.make_ascii_lowercase();
    }
    name
}

// __dom.attrKey(element, how, a, b) -> the key of the attribute — `how` 0 by qualified name `a`, 1 by namespace `a` (null
// for none) and local name `b` — or null for none…
fn attr_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    match find(scope, &args).and_then(|(_, k)| v8::String::new(scope, &k)) {
        Some(k) => rv.set(k.into()),
        None => rv.set_null(),
    }
}
// …__dom.attrGet(element, how, a, b) -> its value, or null — read where the arena holds it, no key copied.
fn attr_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let value: Option<Result<Vec<u16>, String>> = if args.get(1).uint32_value(scope) == Some(0) {
        let name = lowered(scope, id, args.get(2).to_rust_string_lossy(scope));
        node_of(scope, id).and_then(|n| exact_value(n, n.key_by_qname(&name)?))
    } else {
        let ns = if args.get(2).is_null_or_undefined() { String::new() } else { args.get(2).to_rust_string_lossy(scope) };
        let local = args.get(3).to_rust_string_lossy(scope);
        node_of(scope, id).and_then(|n| exact_value(n, n.key_by_ns(&ns, &local)?))
    };
    let string = match value {
        Some(Ok(units)) => v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal),
        Some(Err(text)) => v8::String::new(scope, &text),
        None => return rv.set_null(),
    };
    if let Some(s) = string {
        rv.set(s.into());
    }
}
// The value under `key`: the units it was written as where a lone surrogate made them differ from its text, else its text.
fn exact_value(n: &NodeData, key: &str) -> Option<Result<Vec<u16>, String>> {
    match n.get_attr_u16(key) {
        Some(units) => Some(Ok(units.to_vec())),
        None => n.get_attr(key).map(|v| Err(v.to_owned())),
    }
}
fn find(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<(NodeId, String)> {
    let id = crate::node_handle::nid_of(scope, args.get(0))?;
    let key = if args.get(1).uint32_value(scope) == Some(0) {
        let name = lowered(scope, id, args.get(2).to_rust_string_lossy(scope));
        node_of(scope, id)?.key_by_qname(&name).map(str::to_owned)
    } else {
        let ns = if args.get(2).is_null_or_undefined() { String::new() } else { args.get(2).to_rust_string_lossy(scope) };
        let local = args.get(3).to_rust_string_lossy(scope);
        node_of(scope, id)?.key_by_ns(&ns, &local).map(str::to_owned)
    };
    Some((id, key?))
}

// __dom.attrNames(element, plain) -> the qualified names of its attributes, in order (`getAttributeNames`) — or, `plain`,
// the local names of those in no namespace (a dataset's).
fn attr_names(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let plain = args.get(1).is_true();
    let names: Vec<String> = node_of(scope, id).map_or_else(Vec::new, |n| {
        n.attributes
            .iter()
            .filter_map(|(k, _)| match n.attribute_name(k) {
                (ns, local) if plain => ns.is_empty().then(|| local.to_owned()),
                _ => Some(qualified(k).to_owned()),
            })
            .collect()
    });
    let values: Vec<v8::Local<'_, v8::Value>> = names.iter().filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// Whether a NamedNodeMap's named access reaches the attribute named `name` of `n`, whose document is `doc` (DOM §4.9.1):
// any but one with an ASCII upper alpha of an HTML element in an HTML document.
fn map_reaches(arena: &crate::dom::RealmArena, n: &crate::dom::NodeData, doc: Option<NodeId>, name: &str) -> bool {
    !(n.is_html() && name.bytes().any(|b| b.is_ascii_uppercase()) && arena.document_mode(doc).1)
}
// __dom.attrMapNames(element, docNid) -> [name, …]: its NamedNodeMap's supported property names — its attributes'
// qualified names in order, each once, those named access reaches (`map_reaches`).
fn attr_map_names(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let doc = crate::dom::nid_arg(scope, &args, 1);
    let arena = &crate::dom::dom(scope).arena;
    let mut names: Vec<String> = Vec::new();
    if let Some(n) = arena.get(id) {
        for (k, _) in &n.attributes {
            let name = qualified(k);
            if !names.iter().any(|s| s == name) && map_reaches(arena, n, doc, name) {
                names.push(name.to_owned());
            }
        }
    }
    let values: Vec<v8::Local<'_, v8::Value>> = names.iter().filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}
// __dom.attrMapNamed(element, docNid, name) -> the key of the first of its attributes whose qualified name `name` is,
// where named access reaches it (`map_reaches`), else null.
fn attr_map_named(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let doc = crate::dom::nid_arg(scope, &args, 1);
    let name = args.get(2).to_rust_string_lossy(scope);
    let arena = &crate::dom::dom(scope).arena;
    let Some(n) = arena.get(id) else { return };
    if !map_reaches(arena, n, doc, &name) {
        return;
    }
    let Some(key) = n.attributes.iter().find(|(k, _)| qualified(k) == name).map(|(k, _)| k.clone()) else { return };
    rv.set(v8::String::new(scope, &key).unwrap().into());
}

// HTML's DOMStringMap name conversions (§3.2.6.6 `dataset`): a property name's attribute — `data-` and the name, each
// ASCII upper alpha a U+002D HYPHEN-MINUS and its lowercase — or none where it is no supported property name: a hyphen
// before an ASCII lower alpha, which no attribute's name converts to (the named setter's SyntaxError, a getter's miss).
const HYPHEN: u16 = b'-' as u16;
fn dataset_attr(prop: &[u16]) -> Option<Vec<u16>> {
    if prop.windows(2).any(|w| w[0] == HYPHEN && (u16::from(b'a')..=u16::from(b'z')).contains(&w[1])) {
        return None;
    }
    let mut attr: Vec<u16> = "data-".encode_utf16().collect();
    for &u in prop {
        if (u16::from(b'A')..=u16::from(b'Z')).contains(&u) {
            attr.extend([HYPHEN, u + 0x20]);
        } else {
            attr.push(u);
        }
    }
    Some(attr)
}
// …and the supported property names of an element's: those of its no-namespace attributes named `data-` and no ASCII
// upper alpha after (a `data-Foo` is unreachable through the mapping), each hyphen before an ASCII lower alpha dropped
// and that alpha uppercased — in the attributes' order.
fn dataset_names(n: &NodeData) -> Vec<Vec<u16>> {
    n.attributes
        .iter()
        .filter_map(|(k, _)| match n.attribute_name(k) {
            ("", local) => local.strip_prefix("data-").filter(|rest| !rest.bytes().any(|b| b.is_ascii_uppercase())),
            _ => None,
        })
        .map(|rest| {
            let units: Vec<u16> = rest.encode_utf16().collect();
            let mut name = Vec::with_capacity(units.len());
            let mut i = 0;
            while i < units.len() {
                match units.get(i + 1) {
                    Some(&next) if units[i] == HYPHEN && (u16::from(b'a')..=u16::from(b'z')).contains(&next) => {
                        name.push(next - 0x20);
                        i += 2;
                    }
                    _ => {
                        name.push(units[i]);
                        i += 1;
                    }
                }
            }
            name
        })
        .collect()
}
// __dom.datasetAttr(prop) -> the attribute the `dataset` property name `prop` maps to (`dataset_attr`), or null.
fn dataset_attr_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let prop = crate::dom::utf16_arg(scope, args.get(0));
    match dataset_attr(&prop) {
        Some(attr) => rv.set(crate::dom::utf16_value(scope, &attr)),
        None => rv.set_null(),
    }
}
// __dom.datasetNames(element) -> the element's `dataset` supported property names (`dataset_names`).
fn dataset_names_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let names = node_of(scope, id).map_or_else(Vec::new, dataset_names);
    let values: Vec<v8::Local<'_, v8::Value>> = names.iter().map(|n| crate::dom::utf16_value(scope, n)).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

#[cfg(test)]
mod dataset_tests {
    use super::*;
    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    #[test]
    fn a_property_name_maps_to_its_attribute() {
        assert_eq!(dataset_attr(&u("fooBar")), Some(u("data-foo-bar")));
        assert_eq!(dataset_attr(&u("a-1")), Some(u("data-a-1")));
        assert_eq!(dataset_attr(&u("-foo")), None);
        assert_eq!(dataset_attr(&u("Foo")), Some(u("data--foo")));
    }
}

// __dom.attrName(element, key) -> `[namespace, prefix, localName]` of the attribute stored under `key` (null for none of
// the first two) — what its Attr node says — or undefined for none.
fn attr_name(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let key = args.get(1).to_rust_string_lossy(scope);
    let Some(n) = crate::dom::dom(scope).arena.get(id).filter(|n| n.get_attr(&key).is_some()) else { return };
    let (ns, prefix, local) = name_of(n, &key);
    let (ns, prefix, local) = ((!ns.is_empty()).then(|| ns.to_owned()), prefix.map(str::to_owned), local.to_owned());
    let string = |s: Option<String>| -> v8::Local<'_, v8::Value> { s.and_then(|s| v8::String::new(scope, &s)).map_or_else(|| v8::null(scope).into(), Into::into) };
    let values = [string(ns), string(prefix), string(Some(local))];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// The ways `attrWrite` changes the list: `setAttribute` (qualified name, value), `setAttributeNS` (namespace, qualified
// name, value), the null namespace's attribute set (local name, value: a dataset write), the attribute under a key set
// (key, value: an Attr's `value`), an Attr node bound (namespace, prefix, local name, value: `setAttributeNode`), and
// `removeAttribute` (qualified name), `removeAttributeNS` (namespace, local name) and the attribute under a key removed.
const SET: u32 = 0;
const SET_NS: u32 = 1;
const SET_NULL_NS: u32 = 2;
const SET_KEY: u32 = 3;
const BIND: u32 = 4;
const REMOVE: u32 = 5;
const REMOVE_NS: u32 = 6;
const REMOVE_KEY: u32 = 7;
// …and why one was refused: the extract errors of `validateAndExtract` (1..6), and an invalid attribute name.
const INVALID_NAME: i32 = 7;

// What a change asks of the bindings (dom-nodes.js `attributeChangeSteps`), by the attribute's local name in no
// namespace (`n`) — but the first, which an image's namespaced `xlink:href` asks too.
const STEP_IMAGE: u32 = 1; // an image's source changed: "update the image data"
const STEP_SCRIPT: u32 = 1 << 1; // a script's `src` added: prepare it
const STEP_SHEET: u32 = 1 << 2; // a `<link>`'s or `<style>`'s that selects or obtains its sheet: it follows
const STEP_DISABLED: u32 = 1 << 3; // `disabled` set: the focused element unfocused where it no longer can be
const STEP_NAMED: u32 = 1 << 4; // an `id` or a `name` set: a named property
const STEP_CANVAS: u32 = 1 << 5; // a canvas's `width` / `height`: its bitmap reset
const STEP_DIALOG: u32 = 1 << 6; // a dialog's `open` came or went
const STEP_DETAILS: u32 = 1 << 7; // a details element's `open` came or went: its toggle, its group closed
const STEP_DETAILS_NAME: u32 = 1 << 8; // …its `name`
const STEP_SELECTED: u32 = 1 << 9; // an option's `selected`
const STEP_MULTIPLE: u32 = 1 << 10; // a select's `multiple` removed
const STEP_FRAME_MARGINS: u32 = 1 << 11; // a frame's `marginwidth` / `marginheight`
const STEP_FRAME_SRC: u32 = 1 << 12; // a frame's `src` / `srcdoc`
const STEP_MEDIA_SRC: u32 = 1 << 13; // a `src` set
const STEP_PICTURE: u32 = 1 << 14; // a `<picture>`'s `<source>`'s that selects or sizes its images: their boxes follow
const STEP_HANDLER: u32 = 1 << 15; // an event handler content attribute
const STEP_FORM_OWNER: u32 = 1 << 16; // `form`, `id`, `disabled`: form-associated custom elements' owners
const STEP_FILES: u32 = 1 << 17; // an input become a file input: its files emptied
const STEP_BACKUP: u32 = 1 << 18; // a reaction enqueued: the backup element queue's microtask
const STEP_REMOVED: u32 = 1 << 19; // the attribute removed: its Attr node detached
const STEP_POPOVER: u32 = 1 << 20; // a `popover` changed: a showing popover of another state now hidden
const STEP_LINK_RESOURCE: u32 = 1 << 21; // a `<link>`'s resource may be another: fetched again, its `load` fired
const STEP_PICTURE_SOURCE: u32 = 1 << 22; // …its candidates or what selects it: its images' data updated too
const STEP_PLUGIN: u32 = 1 << 23; // an `<embed>`'s `src` / `type`, an `<object>`'s `data` / `type`: its processing runs

// __dom.attrWrite(element, how, a, b, c, d) -> `[steps, key, oldValue, localName]` of the change made (`how`, above):
// what the bindings do for it (`STEP_*`), the key of the attribute, the value it had (null for none) and its local
// name — undefined where none was made (a removal of an attribute it has not), or a number for why the name was refused.
fn attr_write(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let element = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, element) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    let how = args.get(1).uint32_value(scope).unwrap_or(SET);
    let units = |scope: &mut v8::PinScope<'_, '_>, i: i32| crate::dom::utf16_arg(scope, args.get(i));
    let namespace = |scope: &mut v8::PinScope<'_, '_>, i: i32| (!args.get(i).is_null_or_undefined()).then(|| units(scope, i)).filter(|u| !u.is_empty());
    let text = |u: &[u16]| String::from_utf16_lossy(u);
    // (…the key written, the value it gets — none for a removal — and, for a new attribute in a namespace, its record)
    let (key, value, record): (String, Option<Vec<u16>>, Option<(Vec<u16>, Vec<u16>)>) = {
        match how {
            SET => {
                let name = units(scope, 2);
                if !valid_attribute_local_name(&name) {
                    return rv.set_int32(INVALID_NAME);
                }
                let name = lowered(scope, id, text(&name));
                let key = node_of(scope, id).and_then(|n| n.key_by_qname(&name)).map_or(name, str::to_owned);
                (key, Some(units(scope, 3)), None)
            }
            SET_NS | BIND => {
                let (ns, prefix, local) = if how == SET_NS {
                    match validate_and_extract(namespace(scope, 2), &units(scope, 3), true) {
                        Ok(name) => name,
                        Err(e) => return rv.set_int32(e as i32 + 1),
                    }
                } else {
                    (namespace(scope, 2), namespace(scope, 3), units(scope, 4))
                };
                let qn = match &prefix {
                    Some(p) => format!("{}:{}", text(p), text(&local)),
                    None => text(&local),
                };
                let value = units(scope, if how == SET_NS { 4 } else { 5 });
                // (…the attribute of its namespace and local name replaced, else one appended: names as they are, which
                // neither lowercases)
                let Some(n) = node_of(scope, id) else { return };
                let url = ns.as_deref().map_or_else(String::new, text);
                let namespaced = ns.is_some() && prefix.is_none();
                let (key, renamed) = match n.key_by_ns(&url, &text(&local)) {
                    // (…an Attr taking the place of one of another prefix takes it under its own qualified name: DOM "replace
                    // an attribute")
                    Some(k) if how == BIND && qualified(k) != qn => (n.fresh_key(&qn, namespaced), Some(k.to_owned())),
                    Some(k) => (k.to_owned(), None),
                    None => (n.fresh_key(&qn, namespaced), None),
                };
                if let Some(old) = renamed {
                    crate::dom::rename_attribute(scope, cid, id, &old, &key);
                }
                (key, Some(value), ns.map(|url| (url, local)))
            }
            SET_NULL_NS => {
                let local = units(scope, 2);
                if !valid_attribute_local_name(&local) {
                    return rv.set_int32(INVALID_NAME);
                }
                let local = text(&local);
                let Some(n) = node_of(scope, id) else { return };
                let key = n.key_by_ns("", &local).map_or_else(|| n.fresh_key(&local, false), str::to_owned);
                (key, Some(units(scope, 3)), None)
            }
            SET_KEY => (args.get(2).to_rust_string_lossy(scope), Some(units(scope, 3)), None),
            REMOVE | REMOVE_NS | REMOVE_KEY => {
                let key = match how {
                    REMOVE => {
                        let name = lowered(scope, id, args.get(2).to_rust_string_lossy(scope));
                        node_of(scope, id).and_then(|n| n.key_by_qname(&name)).map(str::to_owned)
                    }
                    REMOVE_NS => {
                        let ns = namespace(scope, 2).map_or_else(String::new, |u| text(&u));
                        let local = args.get(3).to_rust_string_lossy(scope);
                        node_of(scope, id).and_then(|n| n.key_by_ns(&ns, &local)).map(str::to_owned)
                    }
                    _ => Some(args.get(2).to_rust_string_lossy(scope)).filter(|k| node_of(scope, id).is_some_and(|n| n.get_attr(k).is_some())),
                };
                let Some(key) = key else { return };
                (key, None, None)
            }
            _ => return,
        }
    };
    let Some(changed) = change(scope, cid, caller, element, id, &key, value.as_deref(), record) else { return };
    let (steps, old, local) = changed;
    let key_value = v8::String::new(scope, &key).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let old_value = units_or_null(scope, old.as_deref());
    let local_value = v8::String::new(scope, &local).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let values = [v8::Integer::new_from_unsigned(scope, steps).into(), key_value, old_value, local_value];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// The attribute `name` in no namespace of `id` removed by an algorithm of the engine's own (a parser's insertion steps
// closing a details element): the change handled as any removal — its record queued, its reaction enqueued — its steps
// for the bindings answered (`STEP_*`, none where it had none).
pub(crate) fn remove_plain(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, id: NodeId, name: &str) -> u32 {
    let element = crate::dom::node_value(scope, Some(id));
    if element.is_null() {
        return 0;
    }
    change(scope, cid, caller, element, id, name, None, None).map_or(0, |(steps, _, _)| steps)
}

// HTML's value modes of an input's type (§4.10.5): "value", "default", "default/on" and "filename" (input_types.rs).
#[derive(Clone, Copy, PartialEq)]
enum ValueMode {
    Value,
    Default,
    DefaultOn,
    Filename,
}
fn value_mode(ty: &str) -> ValueMode {
    match crate::input_types::value_mode(ty) {
        crate::input_types::MODE_DEFAULT => ValueMode::Default,
        crate::input_types::MODE_DEFAULT_ON => ValueMode::DefaultOn,
        crate::input_types::MODE_FILENAME => ValueMode::Filename,
        _ => ValueMode::Value,
    }
}

// The attribute under `key` of `id` (`element`) changed to `value` (none: removed) by realm `caller`'s code — a new one
// in a namespace with `record` — and the change handled (DOM "handle attribute changes"): the record queued, the reaction
// enqueued, the engine's steps run. What the bindings do for it, the value it had and its local name; None where it is
// a removal of none.
#[allow(clippy::too_many_arguments)]
fn change(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    caller: i32,
    element: v8::Local<'_, v8::Value>,
    id: NodeId,
    key: &str,
    value: Option<&[u16]>,
    record: Option<(Vec<u16>, Vec<u16>)>,
) -> Option<(u32, Option<Vec<u16>>, String)> {
    let arena = realm(scope, cid);
    let n = arena.get(id)?;
    let old: Option<Vec<u16>> = n.attr_units(key).map(|u| u.into_owned());
    if old.is_none() && value.is_none() {
        return None;
    }
    // (…the name the change reports: an existing attribute's own, a new one's from its record or its key)
    let (ns, local) = match &record {
        Some((url, local)) if old.is_none() => (String::from_utf16_lossy(url), String::from_utf16_lossy(local)),
        _ => {
            let (ns, local) = n.attribute_name(key);
            (ns.to_owned(), local.to_owned())
        }
    };
    let plain = ns.is_empty();
    let tag: &str = &n.local_name;
    // (…an input's value mode and selectability under its old type, for its type change)
    let input_type_change = (plain && local == "type" && n.is_html_named("input")).then(|| (value_mode(n.input_type()), arena.selection_applies(n, false)));
    let steps = steps_of(arena, id, tag.to_owned().as_str(), plain, &local, key, old.as_deref(), value);
    crate::dom::store_attribute(scope, cid, id, key, value, if old.is_none() { record.as_ref().map(|(u, l)| (&u[..], &l[..])) } else { None });
    let mut steps = steps | if value.is_none() { STEP_REMOVED } else { 0 };
    // (…the record of it, for each observer that hears of it)
    if realm(scope, caller).observers.observing() {
        let local_value = v8::String::new(scope, &local).map_or_else(|| v8::undefined(scope).into(), Into::into);
        let ns_value: v8::Local<'_, v8::Value> = if plain { v8::null(scope).into() } else { v8::String::new(scope, &ns).map_or_else(|| v8::null(scope).into(), Into::into) };
        let old_value = units_or_null(scope, old.as_deref());
        let undefined: v8::Local<'_, v8::Value> = v8::undefined(scope).into();
        let fields = [v8::Integer::new(scope, 1).into(), element, undefined, undefined, undefined, undefined, local_value, ns_value, old_value];
        crate::mutation_observers::queue_record(scope, caller, id, &fields);
    }
    // (…the reaction — whenever a value is SET, even the one it held: `classList.remove(<absent>)` calls back)
    if crate::dom::dom(scope).arena.get(id).is_some_and(|n| n.state & STATE_CUSTOM != 0) {
        let name: Vec<u16> = local.encode_utf16().collect();
        let old_value = units_or_null(scope, old.as_deref());
        let new_value = units_or_null(scope, value);
        let ns_value: v8::Local<'_, v8::Value> = if plain { v8::null(scope).into() } else { v8::String::new(scope, &ns).map_or_else(|| v8::null(scope).into(), Into::into) };
        if crate::ce_reactions::enqueue_attribute_changed(scope, id, element, &name, [old_value, new_value, ns_value]) {
            steps |= STEP_BACKUP;
        }
    }
    // (…a script's `async` added makes it no longer "force async": HTML §4.12.1)
    let arena = realm(scope, cid);
    // (…a `nonce` set or removed sets the element's nonce: HTML §2.6.4)
    if plain && local == "nonce" {
        arena.set_nonce(id, value.map(<[u16]>::to_vec).unwrap_or_default());
    }
    // (…a sheet owner's attribute that obtains it a new sheet, of those that select it (`steps_of`): a `<style>`'s `type`
    // ("update a style block"); a `<link>`'s `type` or `disabled`, its `rel` or `href` — `disabled` removed making it
    // explicitly enabled)
    if steps & STEP_SHEET != 0 {
        let link = arena.get(id).is_some_and(|n| &*n.local_name == "link");
        let renews = local == "type" || (link && matches!(local.as_str(), "disabled" | "rel" | "href"));
        if renews && arena.renew_sheet(id) && link && local == "disabled" && value.is_none() {
            arena.explicitly_enabled.insert(id);
        }
    }
    if plain && local == "async" && value.is_some() && arena.get(id).is_some_and(is_script) {
        if let Some(n) = arena.get_mut_quietly(id) {
            n.script_flags |= crate::script::SCRIPT_NOT_FORCE_ASYNC;
        }
    }
    if let Some((mode, selectable)) = input_type_change.filter(|_| old.as_deref() != value) {
        steps |= type_change(scope, cid, caller, element, id, mode, selectable);
    }
    Some((steps, old, local))
}

// A script element: an HTML or SVG `<script>`.
pub(crate) fn is_script(n: &NodeData) -> bool {
    &*n.local_name == "script" && (n.is_html() || n.ns == web_atoms::ns!(svg))
}
// The steps of the bindings' a change of the attribute `local` (`plain`: in no namespace) of `id`, a `tag`, from `old` to
// `value` asks for.
#[allow(clippy::too_many_arguments)]
fn steps_of(arena: &RealmArena, id: NodeId, tag: &str, plain: bool, local: &str, key: &str, old: Option<&[u16]>, value: Option<&[u16]>) -> u32 {
    let Some(n) = arena.get(id) else { return 0 };
    let changed = old != value;
    let mut steps = 0;
    // (…of an HTML `<img>` or `<input>`, an SVG `<image>` — by its qualified name: its XLink `xlink:href` sources it too)
    let svg = n.ns == web_atoms::ns!(svg);
    let image = match tag {
        "img" if n.is_html() => matches!(key, "src" | "srcset" | "crossorigin"),
        "image" if svg => matches!(qualified(key), "href" | "xlink:href" | "crossorigin"),
        "input" if n.is_html() => matches!(key, "src" | "type" | "crossorigin"),
        _ => false,
    };
    if changed && image {
        steps |= STEP_IMAGE;
    }
    if !plain {
        return steps;
    }
    let html = n.is_html();
    let set = value.is_some();
    let came_or_went = old.is_some() != set;
    let frame = html && matches!(tag, "iframe" | "frame");
    let script = is_script(n);
    let flag = |on: bool, step: u32| if on { step } else { 0 };
    steps |= flag(script && local == "src" && old.is_none(), STEP_SCRIPT);
    // (…a `<link>`'s `rel`, `href`, `type`, `media`, `title`, `disabled` or `as`, a `<style>`'s `media`, `title` or
    // `type` — but an `href`, a `rel` or an `as` set to the value it had, which changes nothing: the same resource,
    // Chrome 155 keeps the sheet and fetches no preload again — and of those a `<link>`'s that may name another resource:
    // its `rel`, its `href`, its `disabled` removed)
    // (…a sheet owner's: an HTML or SVG `<style>`, an HTML `<link>`)
    let owner = crate::sheet_owners::is_sheet_owner(n);
    let link_sheet = owner
        && tag == "link"
        && match local {
            "rel" | "href" | "as" => changed,
            "type" | "media" | "title" | "disabled" => true,
            _ => false,
        };
    steps |= flag(link_sheet || (owner && tag == "style" && matches!(local, "media" | "title" | "type")), STEP_SHEET);
    steps |= flag(link_sheet && (matches!(local, "rel" | "href") || (local == "disabled" && !set)), STEP_LINK_RESOURCE);
    steps |= flag(local == "disabled" && set, STEP_DISABLED);
    steps |= flag(matches!(local, "id" | "name") && value.is_some_and(|v| !v.is_empty()), STEP_NAMED);
    steps |= flag(html && tag == "canvas" && matches!(local, "width" | "height"), STEP_CANVAS);
    steps |= flag(html && tag == "dialog" && local == "open" && came_or_went, STEP_DIALOG);
    steps |= flag(html && tag == "details" && local == "open" && came_or_went, STEP_DETAILS);
    steps |= flag(html && tag == "details" && local == "name", STEP_DETAILS_NAME);
    steps |= flag(tag == "option" && local == "selected", STEP_SELECTED);
    steps |= flag(tag == "select" && local == "multiple" && !set, STEP_MULTIPLE);
    steps |= flag(frame && matches!(local, "marginwidth" | "marginheight"), STEP_FRAME_MARGINS);
    // (…setting `src` navigates even to the same value — where no `srcdoc` takes precedence; removing either reloads)
    let renavigates = !set || changed || (local == "src" && n.plain_attr("srcdoc").is_none());
    steps |= flag(frame && matches!(local, "src" | "srcdoc") && renavigates, STEP_FRAME_SRC);
    steps |= flag(local == "src" && set, STEP_MEDIA_SRC);
    // (…its resource's attribute set — to the value it had, too — changed or removed, its `type` changed: HTML's embed
    // setup steps and object processing model run for each)
    let resource = matches!((tag, local), ("embed", "src") | ("object", "data"));
    steps |= flag(html && (resource || (changed && local == "type" && matches!(tag, "embed" | "object"))), STEP_PLUGIN);
    // (…a `<source>` a `<picture>` holds, set, changed or removed: HTML's relevant mutations of its images — its
    // candidates and what selects it, `srcset`, `sizes`, `media`, `type` — and the dimensions they take)
    let picture = html && tag == "source" && changed && n.parent.and_then(|p| arena.get(p)).is_some_and(|p| p.is_html_named("picture"));
    let selects = matches!(local, "srcset" | "sizes" | "media" | "type");
    steps |= flag(picture && (selects || matches!(local, "width" | "height")), STEP_PICTURE);
    steps |= flag(picture && selects, STEP_PICTURE_SOURCE);
    steps |= flag(local.starts_with("on") && crate::event_handlers::inline_handler(arena, id, local).is_some(), STEP_HANDLER);
    steps |= flag(changed && matches!(local, "form" | "id" | "disabled"), STEP_FORM_OWNER);
    // (…its state — auto, hint, manual (any other value), none — not its value: HTML's `popover` attribute change steps)
    // (…read only for a showing popover's: a value's state is no write's to compute)
    let state = |v: Option<&[u16]>| crate::popovers::popover_state(v.map(String::from_utf16_lossy).as_deref());
    let popover = html && local == "popover" && n.state & crate::dom::STATE_POPOVER_OPEN != 0;
    steps |= flag(popover && state(old) != state(value), STEP_POPOVER);
    steps
}

// HTML's "input type change" steps — run for the `type` IDL setter and every attribute path alike (Glimmer sets the
// `value` property and then the `type` attribute): the value moved between the live value and the `value` attribute
// as the value mode changes — into the attribute, the change that is, its own record and reaction behind the type's;
// its dirty value sanitized for the new type; a type with a text selection now starting one at its start. `mode` and
// `selectable` the input's under its old type.
fn type_change(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, element: v8::Local<'_, v8::Value>, id: NodeId, mode: ValueMode, selectable: bool) -> u32 {
    let mut steps = 0;
    let Some(next) = realm(scope, cid).get(id).map(|n| value_mode(n.input_type())) else { return 0 };
    let sanitized = |scope: &mut v8::PinScope<'_, '_>, units: &[u16]| -> Vec<u16> {
        let d = crate::dom::dom(scope);
        let arena: &RealmArena = d.arena.enter(cid);
        let engine = d.styles.get(&cid);
        let colour = |v: &str| crate::input_value::colour_value(engine, arena, v);
        let Some(n) = arena.get(id) else { return units.to_vec() };
        crate::input_value::sanitize_units(n.input_type(), units, &crate::input_value::Attrs::of(n), &colour)
    };
    let live = |scope: &mut v8::PinScope<'_, '_>| realm(scope, cid).get(id).and_then(|n| n.value.as_deref().map(<[u16]>::to_vec));
    if mode == ValueMode::Value && matches!(next, ValueMode::Default | ValueMode::DefaultOn) {
        // (…the value the user edits: a dirty one as it is, a clean one its attribute sanitized)
        let value = match live(scope) {
            Some(units) => units,
            None => {
                let attr = realm(scope, cid).get(id).and_then(|n| n.plain_attr_units("value")).unwrap_or_default();
                sanitized(scope, &attr)
            }
        };
        if !value.is_empty() {
            let key = realm(scope, cid).get(id).and_then(|n| n.key_by_ns("", "value")).map_or_else(|| "value".to_owned(), str::to_owned);
            if let Some((more, _, _)) = change(scope, cid, caller, element, id, &key, Some(&value), None) {
                steps |= more & STEP_BACKUP;
            }
        }
        clear_live_value(scope, cid, element, id);
    } else if mode != ValueMode::Value && next == ValueMode::Value {
        clear_live_value(scope, cid, element, id);
    } else if mode != ValueMode::Filename && next == ValueMode::Filename {
        clear_live_value(scope, cid, element, id);
        steps |= STEP_FILES;
    }
    if let Some(units) = live(scope) {
        let value = sanitized(scope, &units);
        if value != units && realm(scope, cid).write_live_value(id, Some(value.into_boxed_slice())) {
            crate::node_handle::forget_live_value(scope, element);
            realm(scope, cid).observers.note_state_changed();
        }
    }
    let arena = realm(scope, cid);
    if !selectable && arena.get(id).is_some_and(|n| arena.selection_applies(n, false)) {
        arena.set_text_selection(id, 0, 0, crate::text_selection::Direction::None);
    }
    steps
}
// …the dirty value flag cleared: the value the `value` attribute again.
fn clear_live_value(scope: &mut v8::PinScope<'_, '_>, cid: i32, element: v8::Local<'_, v8::Value>, id: NodeId) {
    if realm(scope, cid).write_live_value(id, None) {
        crate::node_handle::forget_live_value(scope, element);
        realm(scope, cid).observers.note_state_changed();
    }
}
