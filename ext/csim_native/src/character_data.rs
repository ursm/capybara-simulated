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
    let Some((cid, length)) = crate::dom::dom(scope).arena.get(id).map(|n| (n.realm, n.data.len())) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    if offset > length {
        return rv.set_uint32(OFFSET_PAST_DATA);
    }
    let count = (args.get(2).uint32_value(scope).unwrap_or(0) as usize).min(length - offset);
    if length - count + data.length() > v8::String::MAX_LENGTH {
        return rv.set_uint32(TOO_LONG);
    }
    let caller = realm_id(scope, &args);
    // (…the record first, with the data the node had — its string made only where an observer is to have it)
    if realm(scope, cid).observers.observing() {
        let Some(old) = crate::node_handle::data_string(scope, node) else { return };
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
}
