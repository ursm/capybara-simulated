// DOM "replace data" (§4.10) of a character data node — what `data`, `nodeValue`, `textContent`, `appendData`,
// `insertData`, `deleteData`, `replaceData`, `splitText`, `normalize` and a range's slicing all write by — the engine's
// whole: the offset checked and the count clamped, the `characterData` record queued with the data the node had, the
// live ranges' replace-data steps, the data replaced, and what moves with it: the node's realm's layout mark and, where
// `:empty` flipped, its parent's subtree one; the calling realm's settle and tree generations (a text's data moves no
// collection's members); a `<style>` parent's block updated (sheet_owners.rs), whose cascade is the bindings' to refresh;
// an `<?xml-stylesheet?>`'s sheet obtained again. What the bindings take of it the engine signals (`moFlags`): the
// observations a change schedules, the cascade a `<style>`'s text refreshes.

use crate::dom::{realm, realm_id, GEN_DIRTY, GEN_NODES, GEN_SETTLE, GEN_SUBTREE_MARKS, GEN_TREE};
use crate::mutation_observers::{CASCADE_REFRESH, CASCADE_VERSION, OBSERVATIONS};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "replaceData", replace_data_op, context_id);
    crate::dom::register(scope, ns, "splitText", split_text_op, context_id);
    crate::dom::register(scope, ns, "normalize", normalize_op, context_id);
    crate::dom::register(scope, ns, "xmlName", xml_name_op, context_id);
    crate::dom::register(scope, ns, "pseudoAttributes", pseudo_attributes_op, context_id);
}

// The rules for parsing pseudo-attributes from a string (xml-stylesheet §3) — a processing instruction's attribute map
// (DOM §4.13 "update attributes from data"): `PseudoAtt? (S PseudoAtt)* S?`, each `Name S? = S? PseudoAttValue`, a value
// quoted by `"` or `'`, holding no `<`, its `&` a character reference to a legal character or one of the five predefined
// entities — the names and the values decoded, in their order, or none (an error) where the string is no such list, or
// names one twice.
pub(crate) fn pseudo_attributes(s: &[u16]) -> Option<Vec<(Vec<u16>, Vec<u16>)>> {
    let space = |c: u16| matches!(c, 0x20 | 0x09 | 0x0D | 0x0A);
    let mut map: Vec<(Vec<u16>, Vec<u16>)> = Vec::new();
    let mut i = 0;
    loop {
        let start = i;
        while s.get(i).is_some_and(|&c| space(c)) {
            i += 1;
        }
        if i == s.len() {
            return Some(map);
        }
        if !map.is_empty() && i == start {
            return None;
        }
        let name_start = i;
        while s.get(i).is_some_and(|&c| !space(c) && c != u16::from(b'=')) {
            i += 1;
        }
        let name = &s[name_start..i];
        if !crate::xml_parse::is_xml_name(name) || map.iter().any(|(n, _)| n == name) {
            return None;
        }
        while s.get(i).is_some_and(|&c| space(c)) {
            i += 1;
        }
        if s.get(i) != Some(&u16::from(b'=')) {
            return None;
        }
        i += 1;
        while s.get(i).is_some_and(|&c| space(c)) {
            i += 1;
        }
        let quote = *s.get(i).filter(|&&c| c == u16::from(b'"') || c == u16::from(b'\''))?;
        let end = s[i + 1..].iter().position(|&c| c == quote)? + i + 1;
        map.push((name.to_vec(), pseudo_attribute_value(&s[i + 1..end])?));
        i = end + 1;
    }
}
// …a value decoded: none where it holds a `<` or a reference that is no legal one.
fn pseudo_attribute_value(raw: &[u16]) -> Option<Vec<u16>> {
    if raw.contains(&u16::from(b'<')) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != u16::from(b'&') {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        let semi = raw[i..].iter().position(|&c| c == u16::from(b';'))? + i;
        let name = String::from_utf16(&raw[i + 1..semi]).ok()?;
        let ch = match name.as_str() {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            r => {
                let code = match r.strip_prefix("#x") {
                    Some(hex) if !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()) => u32::from_str_radix(hex, 16).ok()?,
                    _ => match r.strip_prefix('#') {
                        Some(dec) if !dec.is_empty() && dec.chars().all(|c| c.is_ascii_digit()) => dec.parse().ok()?,
                        _ => return None,
                    },
                };
                // (…a reference to a character XML's Char production allows)
                let legal = matches!(code, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF);
                char::from_u32(code).filter(|_| legal)?
            }
        };
        let mut buf = [0u16; 2];
        out.extend_from_slice(ch.encode_utf16(&mut buf));
        i = semi + 1;
    }
    Some(out)
}
fn units_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<u16> {
    let Some(s) = value.to_string(scope) else { return Vec::new() };
    let mut units = vec![0u16; s.length()];
    s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    units
}
// __dom.xmlName(s) -> whether `s` is an XML Name (`xml_parse::is_xml_name`).
fn xml_name_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let s = units_arg(scope, args.get(0));
    rv.set_bool(crate::xml_parse::is_xml_name(&s));
}
// __dom.pseudoAttributes(data) -> [name, value, …], or null where `data` is no list of pseudo-attributes.
fn pseudo_attributes_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = units_arg(scope, args.get(0));
    let Some(map) = pseudo_attributes(&data) else { return rv.set_null() };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(map.len() * 2);
    for (name, value) in &map {
        for text in [name, value] {
            items.push(v8::String::new_from_two_byte(scope, text, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into));
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// Why "replace data" throws: the offset is past the data (an IndexSizeError), or the data it would make is longer than
// a string can be (a RangeError, as V8's own string operations throw — and before anything changed).
const OFFSET_PAST_DATA: u32 = 1;
const TOO_LONG: u32 = 2;

// __dom.replaceData(node, offset, count, data) -> `OFFSET_PAST_DATA`, `TOO_LONG`, or undefined: DOM "replace data" of
// `node` (the object), `count` code units from `offset` replaced with `data` (a string).
fn replace_data_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, node) else { return };
    let Some(data) = args.get(3).to_string(scope) else { return };
    let (offset, count) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(2).uint32_value(scope).unwrap_or(0));
    let caller = realm_id(scope, &args);
    if let Err(refusal) = replace_data(scope, caller, id, node, offset as usize, count as usize, data) {
        rv.set_uint32(refusal);
    }
}
// …of the node in slot `id` (its object `node`), by the realm `caller`'s code — or why it throws.
pub(crate) fn replace_data(
    scope: &mut v8::PinScope<'_, '_>,
    caller: i32,
    id: crate::dom::NodeId,
    node: v8::Local<'_, v8::Value>,
    offset: usize,
    count: usize,
    data: v8::Local<'_, v8::String>,
) -> Result<(), u32> {
    let Some((cid, length)) = crate::dom::dom(scope).arena.get(id).map(|n| (n.realm, n.data.len())) else { return Ok(()) };
    if offset > length {
        return Err(OFFSET_PAST_DATA);
    }
    let count = count.min(length - offset);
    if length - count + data.length() > v8::String::MAX_LENGTH {
        return Err(TOO_LONG);
    }
    // (…the record first, with the data the node had — its string made only where an observer is to have it)
    if realm(scope, cid).observers.observing() {
        let Some(old) = crate::node_handle::data_string(scope, node) else { return Ok(()) };
        let undefined: v8::Local<'_, v8::Value> = v8::undefined(scope).into();
        let kind = v8::Integer::new(scope, 2).into();
        let fields = [kind, node, undefined, undefined, undefined, undefined, undefined, undefined, old.into()];
        crate::mutation_observers::queue_record(scope, cid, id, &fields);
    }
    crate::ranges::replace_data(scope, id, offset as u32, count as u32, data.length() as u32);
    // (…an append the cons of the two strings — an `appendData` loop and the parser's coalescing copy nothing — a
    // replacement of the whole, the `data` setter's, the string given; any other a splice of the arena's code units, the
    // node's string made of them again when next read)
    let new_length = length - count + data.length();
    let changed = if offset == length {
        crate::dom::write_data_of(scope, node, data, true)
    } else if offset == 0 && count == length {
        crate::dom::write_data_of(scope, node, data, false)
    } else {
        let mut units = vec![0u16; data.length()];
        data.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        let same = crate::dom::dom(scope).arena.get(id).is_some_and(|n| n.data[offset..offset + count] == units[..]);
        if !same {
            crate::node_handle::forget_data(scope, node);
            crate::dom::splice_data(scope, id, offset, count, &units);
        }
        // (…a `<style>`'s block updated by any write — to the same units, too — as the other two update it)
        let arena = realm(scope, cid);
        if let Some(parent) = arena.parent_of(id) {
            arena.style_block_changed(parent);
        }
        !same
    };
    let arena = realm(scope, cid);
    let parent = arena.parent_of(id);
    if changed {
        arena.generations.bump(GEN_DIRTY);
        if (length == 0) != (new_length == 0) && parent.is_some_and(|p| arena.is_element(p)) {
            arena.generations.bump(GEN_SUBTREE_MARKS);
            arena.generations.bump(GEN_DIRTY);
        }
        let callers = &realm(scope, caller).generations;
        callers.bump(GEN_SETTLE);
        callers.bump(GEN_TREE);
        crate::dom::dom(scope).arena.observers.note(OBSERVATIONS);
    }
    let arena = realm(scope, cid);
    arena.renew_sheet(id);
    // (…a `<style>` parent's block updated — the style elements that own a sheet, sheet_owners.rs)
    let style_element = |n: &crate::dom::NodeData| &*n.local_name == "style" && crate::sheet_owners::is_sheet_owner(n);
    if let Some(style) = parent.filter(|&p| arena.get(p).is_some_and(style_element)) {
        let in_shadow = arena.get(arena.root_of(style)).is_some_and(|r| r.host.is_some());
        let callers = &realm(scope, caller).generations;
        callers.bump(GEN_TREE);
        callers.bump(GEN_NODES);
        crate::dom::dom(scope).arena.observers.note(if in_shadow { CASCADE_VERSION } else { CASCADE_REFRESH });
    }
    Ok(())
}

// __dom.splitText(node, offset, steps) -> [newNode, changes…], or `OFFSET_PAST_DATA`: DOM "split a Text node" (§4.11) of `node`
// (the object) at `offset`, the engine's whole — a Text node of the same kind (a CDATASection's a CDATASection) holding
// the data past `offset`, in `node`'s node document; where `node` has a parent, inserted after it (its childList
// record, `steps` the bindings' steps of a change of children: mutation.rs `change_children`) and the live ranges'
// split steps; then the data past `offset` replaced with none (its characterData record). With the change it made, for
// the bindings to finish (mutation.rs `changes_value`).
fn split_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, node) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(2)) else { return };
    let caller = realm_id(scope, &args);
    let Some((cid, length)) = crate::dom::dom(scope).arena.get(id).map(|n| (n.realm, n.data.len())) else { return };
    if offset > length {
        return rv.set_uint32(OFFSET_PAST_DATA);
    }
    let Some((new, changes)) = split_text(scope, caller, id, node, offset, steps) else { return };
    let mut out = vec![crate::dom::node_value(scope, Some(new))];
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}
// …of the node in slot `id` (its object `node`) at `offset`, no further than its data, by the realm `caller`'s code: the
// new node and the change it made.
pub(crate) fn split_text(
    scope: &mut v8::PinScope<'_, '_>,
    caller: i32,
    id: crate::dom::NodeId,
    node: v8::Local<'_, v8::Value>,
    offset: usize,
    steps: v8::Local<'_, v8::Array>,
) -> Option<(crate::dom::NodeId, Vec<crate::mutation::Change>)> {
    let (cid, length, cdata, parent) = crate::dom::dom(scope).arena.get(id).map(|n| (n.realm, n.data.len(), n.cdata, n.parent))?;
    // (…the new node made in the engine, its object made by the factory of the node's realm, as its own was — held here
    // until then)
    let tail = crate::dom::dom(scope).arena.get(id).map_or_else(Vec::new, |n| n.data[offset..].to_vec());
    let doc = crate::node_handle::handle_of(scope, node).and_then(|h| unsafe { h.as_ref() }.document(scope));
    let new = realm(scope, cid).create(crate::dom::NodeData { cdata, ..crate::dom::NodeData::of_kind(crate::dom::NodeKind::Text, tail) }, None);
    let held = crate::node_handle::bare(scope, new, doc, cid);
    let new_value = crate::dom::node_value(scope, Some(new));
    if crate::dom::factory_threw(scope) {
        return None;
    }
    drop(held);
    let new_obj = v8::Local::<v8::Object>::try_from(new_value).ok()?;
    let mut changes = Vec::new();
    if let Some(parent) = parent {
        let arena = realm(scope, cid);
        let (next, slot) = (arena.sibling(id, 1), arena.child_index(id) as u32 + 1);
        changes.push(crate::mutation::insert(scope, cid, caller, parent, &[new], next, steps)?);
        crate::ranges::split(scope, id, offset as u32, new, new_obj, Some(parent), slot);
    }
    let none = v8::String::empty(scope);
    replace_data(scope, caller, id, node, offset, length - offset, none).ok()?;
    Some((new, changes))
}

// __dom.normalize(node, steps) -> [changes…]: DOM `normalize()` (§4.4) of `node` (the object), the engine's whole — for
// each exclusive Text node among its descendants, in tree order: one with no data removed; any other given the data of
// the exclusive Text nodes that follow it (its characterData record), the live ranges in them moved into it, and those
// removed (each its childList record). With the changes it made, for the bindings to finish (mutation.rs
// `changes_value`).
fn normalize_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(1)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(root).map(|n| n.realm) else { return };
    let exclusive = |arena: &crate::dom::RealmArena, n: crate::dom::NodeId| arena.get(n).is_some_and(|d| d.kind == crate::dom::NodeKind::Text && !d.cdata);
    // (…the descendants in tree order: a stack, last child pushed first)
    let texts: Vec<crate::dom::NodeId> = {
        let arena = realm(scope, cid);
        let (mut out, mut stack) = (Vec::new(), arena.get(root).map_or_else(Vec::new, |n| n.children.iter().rev().copied().collect::<Vec<_>>()));
        while let Some(n) = stack.pop() {
            if exclusive(arena, n) {
                out.push(n);
            }
            stack.extend(arena.get(n).map_or(&[][..], |d| &d.children[..]).iter().rev());
        }
        out
    };
    let mut changes = Vec::new();
    for node in texts {
        // (…one merged into the one before it is gone)
        let arena = realm(scope, cid);
        let Some(parent) = arena.parent_of(node) else { continue };
        let length = arena.get(node).map_or(0, |n| n.data.len());
        if length == 0 {
            let Some(change) = crate::mutation::remove(scope, cid, caller, node, steps) else { return };
            changes.push(change);
            continue;
        }
        let mut following = Vec::new();
        let mut at = arena.sibling(node, 1);
        while let Some(n) = at.filter(|&n| exclusive(arena, n)) {
            following.push((n, arena.child_index(n) as u32, arena.get(n).map_or(0, |d| d.data.len() as u32)));
            at = arena.sibling(n, 1);
        }
        if following.is_empty() {
            continue;
        }
        let data: Vec<u16> = following.iter().flat_map(|&(n, ..)| arena.get(n).map_or_else(Vec::new, |d| d.data.clone())).collect();
        let object = crate::dom::node_value(scope, Some(node));
        if crate::dom::factory_threw(scope) {
            return;
        }
        let Some(joined) = v8::String::new_from_two_byte(scope, &data, v8::NewStringType::Normal) else { return };
        if replace_data(scope, caller, node, object, length, 0, joined).is_err() {
            return;
        }
        let Ok(node_obj) = v8::Local::<v8::Object>::try_from(object) else { return };
        let mut offset = length as u32;
        for &(n, index, len) in &following {
            crate::ranges::merge(scope, node, node_obj, n, parent, index, offset);
            offset += len;
        }
        for &(n, ..) in &following {
            let Some(change) = crate::mutation::remove(scope, cid, caller, n, steps) else { return };
            changes.push(change);
        }
    }
    let out = crate::mutation::changes_value(scope, cid, &changes);
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

#[cfg(test)]
mod tests {
    use super::pseudo_attributes;

    fn parse(s: &str) -> Option<Vec<(String, String)>> {
        let units: Vec<u16> = s.encode_utf16().collect();
        pseudo_attributes(&units).map(|m| m.into_iter().map(|(n, v)| (String::from_utf16_lossy(&n), String::from_utf16_lossy(&v))).collect())
    }

    #[test]
    fn pseudo_attributes_parse_as_xml_stylesheet_says() {
        assert_eq!(parse(r#" href="a.css" type='text/css' "#), Some(vec![("href".into(), "a.css".into()), ("type".into(), "text/css".into())]));
        assert_eq!(parse(r#"t="&lt;&#x41;&#66;&quot;""#), Some(vec![("t".into(), "<AB\"".into())]));
        assert_eq!(parse(r#"a="1"b="2""#), None);
        assert_eq!(parse(r#"a="1" a="2""#), None);
        assert_eq!(parse(r#"a="&#0;""#), None);
        assert_eq!(parse(r#"a="<""#), None);
        assert_eq!(parse(r#"a="&nbsp;""#), None);
        assert_eq!(parse(""), Some(vec![]));
    }
}
