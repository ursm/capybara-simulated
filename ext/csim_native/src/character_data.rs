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

// Why "replace data" throws (an IndexSizeError): the offset is past the data.
const OFFSET_PAST_DATA: u32 = 1;

// __dom.replaceData(node, offset, count, data) -> `OFFSET_PAST_DATA`, or undefined: DOM "replace data" of `node` (the
// object), `count` code units from `offset` replaced with `data` (a string).
fn replace_data_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, node) else { return };
    let (Some(old), Some(data)) = (crate::node_handle::data_string(scope, node), args.get(3).to_string(scope)) else { return };
    let length = old.length() as u32;
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    if offset > length {
        return rv.set_uint32(OFFSET_PAST_DATA);
    }
    let count = args.get(2).uint32_value(scope).unwrap_or(0).min(length - offset);
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    // (…the record first, with the data the node had)
    let undefined: v8::Local<'_, v8::Value> = v8::undefined(scope).into();
    let kind = v8::Integer::new(scope, 2).into();
    let fields = [kind, node, undefined, undefined, undefined, undefined, undefined, undefined, old.into()];
    crate::mutation_observers::queue_record(scope, cid, id, &fields);
    crate::ranges::replace_data(scope, id, offset, count, data.length() as u32);
    // (…an append the cons of the two strings — an `appendData` loop and the parser's coalescing copy nothing — and a
    // replacement of the whole, the `data` setter's, the string given)
    let appended = offset == length;
    let replaced = if appended || (offset == 0 && count == length) {
        data
    } else {
        let units = |s: v8::Local<'_, v8::String>, scope: &mut v8::PinScope<'_, '_>| {
            let mut u = vec![0u16; s.length()];
            s.write_v2(scope, 0, &mut u, v8::WriteFlags::empty());
            u
        };
        let mut whole = units(old, scope);
        whole.splice(offset as usize..(offset + count) as usize, units(data, scope));
        let Some(s) = v8::String::new_from_two_byte(scope, &whole, v8::NewStringType::Normal) else { return };
        s
    };
    let changed = if appended { data.length() != 0 } else { !replaced.strict_equals(old.into()) };
    crate::dom::write_data_of(scope, node, replaced, appended);
    let arena = realm(scope, cid);
    let parent = arena.parent_of(id);
    if changed {
        arena.generations.bump(GEN_DIRTY);
        let emptied = (length == 0) != (length - count + data.length() as u32 == 0);
        if emptied && parent.is_some_and(|p| arena.is_element(p)) {
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
    if let Some(style) = parent.filter(|&p| arena.get(p).is_some_and(|n| &*n.local_name == "style")) {
        let in_shadow = arena.get(arena.root_of(style)).is_some_and(|r| r.host.is_some());
        let callers = &realm(scope, caller).generations;
        callers.bump(GEN_TREE);
        callers.bump(GEN_NODES);
        crate::dom::dom(scope).arena.observers.note(if in_shadow { CASCADE_VERSION } else { CASCADE_REFRESH });
    }
}

