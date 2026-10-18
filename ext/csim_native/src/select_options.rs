// HTMLOptionsCollection's tree changes (HTML §2.6.4) a select's list of options (validity.rs `list_of_options`) makes
// itself: blank options appended — the `length` setter's, and the padding an indexed setter puts before its option —
// at once, one DocumentFragment of them as HTML says (one mutation record, not one per option), and options removed
// from the list. What an option a page hands over goes through — an `add()`'s, an indexed setter's — is the bindings'
// pre-insertion (its adoption and checks), with the place these steps answer.

use crate::dom::{nid_arg, realm, realm_id, NodeId};

// The most blank options one change appends — an indexed write's padding, which HTML does not bound: to an index near
// 2^32 it would hang (Chrome refuses one past about as many, Firefox throws). (The `length` setter's own bound is on the
// value it is given, the bindings'.)
const PAD_LIMIT: u32 = 100_000;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "optionsPad", options_pad, context_id);
    crate::dom::register(scope, ns, "optionsRemove", options_remove, context_id);
}

// __dom.optionsPad(select, count, steps) -> [null, changes…]: `count` new blank options — HTML elements of the select's
// node document, made by the calling realm's code — appended to the select at once; nothing for none, or for more than
// `PAD_LIMIT`.
fn options_pad(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(select) = nid_arg(scope, &args, 0) else { return };
    let count = args.get(1).uint32_value(scope).unwrap_or(0);
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(2)) else { return };
    if count == 0 || count > PAD_LIMIT {
        return;
    }
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(select).map(|n| n.realm) else { return };
    let (mut made, mut held) = (Vec::new(), Vec::new());
    for _ in 0..count {
        let (option, handle) = crate::editing::make_element(scope, cid, caller, select, "option");
        made.push(option);
        held.push(handle);
    }
    let Some(change) = crate::mutation::insert(scope, cid, caller, select, &made, None, steps) else { return };
    if let Some(out) = crate::tables::answer(scope, cid, None, &[change]) {
        rv.set(out);
    }
    drop(held);
}

// __dom.optionsRemove(select, from, to, steps) -> [null, changes…]: the options of the select's list at `from`..`to`
// removed from their parents, the last first (the `length` setter's shrinking: each its own removal) — `remove(index)`'s
// and a null indexed write's one, `to` `from` + 1; none out of range.
fn options_remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(select) = nid_arg(scope, &args, 0) else { return };
    let from = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let to = args.get(2).uint32_value(scope).unwrap_or(0) as usize;
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(3)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(select).map(|n| n.realm) else { return };
    let options: Vec<NodeId> = realm(scope, cid).list_of_options(select);
    let gone: Vec<NodeId> = options.get(from..to.min(options.len())).map(<[NodeId]>::to_vec).unwrap_or_default();
    let mut changes = Vec::new();
    for &option in gone.iter().rev() {
        let Some(change) = crate::mutation::remove(scope, cid, caller, option, steps) else { return };
        changes.push(change);
    }
    if let Some(out) = crate::tables::answer(scope, cid, None, &changes) {
        rv.set(out);
    }
}
