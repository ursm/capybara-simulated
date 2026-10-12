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
    let Some((cid, length, cdata, parent)) = crate::dom::dom(scope).arena.get(id).map(|n| (n.realm, n.data.len(), n.cdata, n.parent)) else { return };
    if offset > length {
        return rv.set_uint32(OFFSET_PAST_DATA);
    }
    // (…the new node made in the engine, its object made by the realm's factory — held here until then)
    let tail = crate::dom::dom(scope).arena.get(id).map_or_else(Vec::new, |n| n.data[offset..].to_vec());
    let doc = crate::node_handle::handle_of(scope, node).and_then(|h| unsafe { h.as_ref() }.document(scope));
    let new = realm(scope, cid).create(crate::dom::NodeData { cdata, ..crate::dom::NodeData::of_kind(crate::dom::NodeKind::Text, tail) }, None);
    let held = crate::node_handle::bare(scope, new, doc);
    let new_value = crate::dom::node_value(scope, Some(new));
    drop(held);
    let Ok(new_obj) = v8::Local::<v8::Object>::try_from(new_value) else { return };
    let mut changes = Vec::new();
    if let Some(parent) = parent {
        let arena = realm(scope, cid);
        let (next, slot) = (arena.sibling(id, 1), arena.child_index(id) as u32 + 1);
        let Some(change) = crate::mutation::insert(scope, cid, caller, parent, &[new], next, steps) else { return };
        changes.push(change);
        crate::ranges::split(scope, id, offset as u32, new, new_obj, Some(parent), slot);
    }
    let none = v8::String::empty(scope);
    if replace_data(scope, caller, id, node, offset, length - offset, none).is_err() {
        return;
    }
    let mut out = vec![new_value];
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    rv.set(v8::Array::new_with_elements(scope, &out).into());
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
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}
