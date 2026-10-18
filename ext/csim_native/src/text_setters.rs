// HTML's `innerText` and `outerText` setters (§3.2.7): the "rendered text fragment" of a value — its runs between line
// breaks as Text, each line break (CR LF, CR or LF) a `<br>` — put in place of the element's children, or of the element
// itself, its Text neighbours then merged with what came in. The getters, the rendered text collection, are rendered.rs'.

use crate::dom::{nid_arg, realm, realm_id, NodeData, NodeId, NodeKind};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "setInnerText", set_inner_text, context_id);
    crate::dom::register(scope, ns, "setOuterText", set_outer_text, context_id);
}

// The runs of `units` between its line breaks: one more than it has line breaks, an empty one where two meet or one
// ends it.
fn runs(units: &[u16]) -> Vec<&[u16]> {
    let (mut runs, mut start, mut i) = (Vec::new(), 0, 0);
    while i < units.len() {
        let width = match units[i] {
            0x0D if units.get(i + 1) == Some(&0x0A) => 2,
            0x0D | 0x0A => 1,
            _ => {
                i += 1;
                continue;
            }
        };
        runs.push(&units[start..i]);
        i += width;
        start = i;
    }
    runs.push(&units[start..]);
    runs
}

// The rendered text fragment's nodes, in `near`'s node document, made by realm `caller`'s code — a Text of each run but
// an empty one, a `<br>` between each two — and what holds their handles until a tree does.
fn fragment_nodes(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, near: NodeId, units: &[u16]) -> (Vec<NodeId>, Vec<v8::cppgc::Persistent<crate::node_handle::NodeHandle>>) {
    let (mut nodes, mut held) = (Vec::new(), Vec::new());
    for (i, run) in runs(units).into_iter().enumerate() {
        if i > 0 {
            let (br, handle) = crate::editing::make_br(scope, cid, caller, near);
            nodes.push(br);
            held.push(handle);
        }
        if !run.is_empty() {
            let (text, handle) = crate::editing::make(scope, cid, caller, near, NodeData::of_kind(NodeKind::Text, run.to_vec()));
            nodes.push(text);
            held.push(handle);
        }
    }
    (nodes, held)
}

fn value_units(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<u16> {
    let Some(value) = value.to_string(scope) else { return Vec::new() };
    let mut units = vec![0u16; value.length()];
    value.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    units
}

// __dom.setInnerText(element, value, steps) -> [null, changes…]: the element's children replaced by the rendered text
// fragment of `value` (DOM "replace all": one change).
fn set_inner_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(element) = nid_arg(scope, &args, 0) else { return };
    let units = value_units(scope, args.get(1));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(2)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(element).map(|n| n.realm) else { return };
    let (nodes, held) = fragment_nodes(scope, cid, caller, element, &units);
    let Some(change) = crate::mutation::replace_all(scope, cid, caller, element, &nodes, steps) else { return };
    if let Some(out) = crate::tables::answer(scope, cid, None, &[change]) {
        rv.set(out);
    }
    drop(held);
}

// __dom.setOuterText(element, value, steps) -> [null, changes…], or false for an element with no parent (the bindings'
// NoModificationAllowedError): the element replaced by the rendered text fragment of `value` — a lone empty Text where
// it has no node — and then the Text before what came in, and the one it ends with, each merged with the Text after it
// ("merge with the next text node": only those two, not a full normalize).
fn set_outer_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(element) = nid_arg(scope, &args, 0) else { return };
    let units = value_units(scope, args.get(1));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(2)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(element).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    if arena.parent_of(element).is_none() {
        return rv.set_bool(false);
    }
    let (next, previous) = (arena.sibling(element, 1), arena.sibling(element, -1));
    let (mut nodes, mut held) = fragment_nodes(scope, cid, caller, element, &units);
    if nodes.is_empty() {
        let (text, handle) = crate::editing::make(scope, cid, caller, element, NodeData::of_kind(NodeKind::Text, Vec::new()));
        nodes.push(text);
        held.push(handle);
    }
    let Some(change) = crate::mutation::replace(scope, cid, caller, element, &nodes, steps) else { return };
    let mut changes = vec![change];
    let last = next.and_then(|n| realm(scope, cid).sibling(n, -1));
    for text in [last, previous].into_iter().flatten() {
        if !merge_with_next_text(scope, cid, caller, text, steps, &mut changes) {
            return;
        }
    }
    if let Some(out) = crate::tables::answer(scope, cid, None, &changes) {
        rv.set(out);
    }
    drop(held);
}

// HTML "merge with the next text node": where `node` is a Text and its next sibling one, that one's data appended to it
// and that one removed — false where the realm's code threw.
fn merge_with_next_text(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, node: NodeId, steps: v8::Local<'_, v8::Array>, changes: &mut Vec<crate::mutation::Change>) -> bool {
    let arena = realm(scope, cid);
    let text = |n: NodeId| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text);
    let Some(next) = arena.sibling(node, 1).filter(|&n| text(node) && text(n)) else { return true };
    let (Some(at), Some(data)) = (arena.get(node).map(|d| d.data.len()), arena.get(next).map(|d| d.data.clone())) else { return true };
    let object = crate::dom::node_value(scope, Some(node));
    if crate::dom::factory_threw(scope) {
        return false;
    }
    let Some(joined) = v8::String::new_from_two_byte(scope, &data, v8::NewStringType::Normal) else { return false };
    if crate::character_data::replace_data(scope, caller, node, object, at, 0, joined).is_err() {
        return false;
    }
    match crate::mutation::remove(scope, cid, caller, next, steps) {
        Some(change) => {
            changes.push(change);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_breaks_into_runs_at_each_line_break() {
        let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        let texts = |s: &str| runs(&units(s)).into_iter().map(String::from_utf16_lossy).collect::<Vec<_>>();
        assert_eq!(texts("ab"), ["ab"]);
        assert_eq!(texts(""), [""]);
        assert_eq!(texts("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
        assert_eq!(texts("\n\r\n"), ["", "", ""]);
        assert_eq!(texts("a\n\rb"), ["a", "", "b"]);
    }
}
