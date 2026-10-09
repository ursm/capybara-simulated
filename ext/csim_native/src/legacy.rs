// A legacy platform object with an indexed getter (Web IDL §3.9) made natively: an object of V8's own whose indexed
// properties an interceptor answers from its implementation — `item(i)` (null for an index it does not support) and
// `length()`, the functions its internal fields hold — as Web IDL's [[GetOwnProperty]], [[DefineOwnProperty]],
// [[Delete]], [[Set]] and [[OwnPropertyKeys]] have them: each supported index an own data property, read-only,
// enumerable and configurable, which can be neither defined nor deleted; no index set, supported or not. Unlike the
// Proxy `withIndexedGetter` makes (webidl.js), it is no exotic JS object to V8's serializer, which hands it to the
// bindings' hook (clone.rs) as the platform object it is.

use crate::dom::{dom, register};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "indexedObject", indexed_object, context_id);
}

// The template, made once per isolate.
fn template<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::ObjectTemplate> {
    if let Some(t) = dom(scope).indexed_template.clone() {
        return v8::Local::new(scope, t);
    }
    let t = v8::ObjectTemplate::new(scope);
    t.set_internal_field_count(2);
    t.set_indexed_property_handler(
        v8::IndexedPropertyHandlerConfiguration::new()
            .getter(get)
            .setter(set)
            .query(query)
            .deleter(delete)
            .definer(define)
            .descriptor(descriptor)
            .enumerator(enumerate),
    );
    dom(scope).indexed_template = Some(v8::Global::new(scope, t));
    t
}

// __dom.indexedObject(prototype, item, length) -> a new one, its [[Prototype]] `prototype`.
fn indexed_object(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let template = template(scope);
    let Some(object) = template.new_instance(scope) else { return };
    object.set_internal_field(0, args.get(1).into());
    object.set_internal_field(1, args.get(2).into());
    object.set_prototype(scope, args.get(0));
    rv.set(object.into());
}

// The implementation's answer for index `i` of the object the interceptor runs on: its item, or None where it does not
// support the index (or threw, which propagates).
fn item<'s>(scope: &mut v8::PinScope<'s, '_>, holder: v8::Local<'_, v8::Object>, i: u32) -> Option<v8::Local<'s, v8::Value>> {
    let f = holder.get_internal_field(scope, 0).and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())?;
    let undefined = v8::undefined(scope).into();
    let index = v8::Integer::new_from_unsigned(scope, i).into();
    f.call(scope, undefined, &[index]).filter(|v| !v.is_null())
}
fn length(scope: &mut v8::PinScope<'_, '_>, args: &v8::PropertyCallbackArguments<'_>) -> u32 {
    let Some(f) = args.holder().get_internal_field(scope, 1).and_then(|f| v8::Local::<v8::Function>::try_from(f).ok()) else {
        return 0;
    };
    let undefined = v8::undefined(scope).into();
    f.call(scope, undefined, &[]).and_then(|v| v.uint32_value(scope)).unwrap_or(0)
}

fn get(scope: &mut v8::PinScope<'_, '_>, i: u32, args: v8::PropertyCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) -> v8::Intercepted {
    match item(scope, args.holder(), i) {
        Some(value) => {
            rv.set(value);
            v8::Intercepted::kYes
        }
        None => v8::Intercepted::kNo,
    }
}

// (…no index set, and none defined: refused — V8 throws a TypeError where its caller throws on a refusal)
fn set(
    _scope: &mut v8::PinScope<'_, '_>,
    _i: u32,
    _value: v8::Local<'_, v8::Value>,
    _args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, ()>,
) -> v8::Intercepted {
    rv.set_bool(false);
    v8::Intercepted::kYes
}
fn define(
    _scope: &mut v8::PinScope<'_, '_>,
    _i: u32,
    _descriptor: &v8::PropertyDescriptor,
    _args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, ()>,
) -> v8::Intercepted {
    rv.set_bool(false);
    v8::Intercepted::kYes
}

fn query(scope: &mut v8::PinScope<'_, '_>, i: u32, args: v8::PropertyCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Integer>) -> v8::Intercepted {
    if i >= length(scope, &args) {
        return v8::Intercepted::kNo;
    }
    rv.set(v8::Integer::new(scope, v8::PropertyAttribute::READ_ONLY.as_u32() as i32));
    v8::Intercepted::kYes
}

// (…a supported index not deleted, an unsupported one the ordinary deletion)
fn delete(scope: &mut v8::PinScope<'_, '_>, i: u32, args: v8::PropertyCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Boolean>) -> v8::Intercepted {
    if i >= length(scope, &args) {
        return v8::Intercepted::kNo;
    }
    rv.set_bool(false);
    v8::Intercepted::kYes
}

fn descriptor(scope: &mut v8::PinScope<'_, '_>, i: u32, args: v8::PropertyCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) -> v8::Intercepted {
    let Some(value) = item(scope, args.holder(), i) else { return v8::Intercepted::kNo };
    let d = v8::Object::new(scope);
    for (key, v) in [
        ("value", value),
        ("writable", v8::Boolean::new(scope, false).into()),
        ("enumerable", v8::Boolean::new(scope, true).into()),
        ("configurable", v8::Boolean::new(scope, true).into()),
    ] {
        let Some(key) = v8::String::new(scope, key) else { return v8::Intercepted::kNo };
        d.set(scope, key.into(), v);
    }
    rv.set(d.into());
    v8::Intercepted::kYes
}

fn enumerate(scope: &mut v8::PinScope<'_, '_>, args: v8::PropertyCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Array>) {
    let n = length(scope, &args);
    let indices: Vec<v8::Local<v8::Value>> = (0..n).map(|i| v8::Integer::new_from_unsigned(scope, i).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &indices));
}
