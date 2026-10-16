// The flags of an element's own steps that no attribute carries (`NodeData::element_flags`), which the bindings set
// and read (element-flags.js names them): a `<select>`'s "has a `<selectedcontent>`" it keeps mirroring its
// selection; a select's and a selectedcontent's "connected before" (a re-insertion re-snapshots); a select's "update
// running", which an update it causes waits out; a `<form>`'s "constructing entry list", "firing submission events"
// and "locked for reset" (HTML §4.10.21.3, §4.10.21.4, §4.10.22); and a `<style>`'s queued `load`. A clone starts
// without any.

use crate::dom::nid_arg;

const ELEMENT_FLAGS: u8 = 0b111_1111;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "elementFlags", element_flags, context_id);
    crate::dom::register(scope, ns, "setElementFlags", set_element_flags, context_id);
}

// __dom.elementFlags(nid) -> the element's flags.
fn element_flags(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(u32::from(crate::dom::dom(scope).arena.get(id).map_or(0, |n| n.element_flags)));
}

// __dom.setElementFlags(nid, mask, bits) — the flags in `mask` set to `bits`'.
fn set_element_flags(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let mask = (args.get(1).uint32_value(scope).unwrap_or(0) as u8) & ELEMENT_FLAGS;
    let bits = args.get(2).uint32_value(scope).unwrap_or(0) as u8;
    // (…no input to any memo of the arena, nor to a layout: a write that moves none)
    if let Some(n) = crate::dom::dom(scope).arena.get_mut_quietly(id) {
        n.element_flags = (n.element_flags & !mask) | (bits & mask);
    }
}
