// What a script cannot tell of a value by itself, which the bindings ask of the engine: a SharedArrayBuffer, and an
// Array exotic object (a Proxy around an array answers `Array.isArray` as its target does, but is none).

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "isSharedArrayBuffer", is_shared_array_buffer, context_id);
    register(scope, ns, "isArrayExotic", is_array_exotic, context_id);
}

// __dom.isSharedArrayBuffer(value) -> whether it is a SharedArrayBuffer, any realm's (Web IDL's IsSharedArrayBuffer):
// the bindings' buffer-source conversions ask (webidl.js), which a realm with no SharedArrayBuffer constructor — every
// one here, none being cross-origin isolated — has no getter of its own to brand-check one with.
fn is_shared_array_buffer(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(args.get(0).is_shared_array_buffer());
}

// __dom.isArrayExotic(value) -> whether it is an Array exotic object, any realm's: IndexedDB's "convert a value to a
// key" takes one as an array key and a Proxy of one as no key at all (idb.js).
fn is_array_exotic(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(args.get(0).is_array());
}
