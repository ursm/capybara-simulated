// The WebAssembly JS API's embedder hooks. `WebAssembly.compile` / `instantiate` settle their promise as a task of
// the realm's event loop (the WebAssembly JS API's "asynchronously compile a WebAssembly module": resolve "in a
// queued task") — V8 hands the embedder the resolution (`SetWasmAsyncResolvePromiseCallback`) and this queues it, a
// timer task of the bindings (`__csimSetTimeout`), never inside the call that started it. (V8 compiles on the calling
// thread, `--no-wasm-async-compilation` (v8_runtime.rb): its asynchronous compile finishes on platform tasks the
// driver's event loop does not run.)

use crate::dom::dom;

// A resolution V8 handed over and its task has not run: the realm it is of (its entries go with it — a frame removed
// or navigated, whose timers never run: `drop_realm`), the promise's resolver, the value, and whether it succeeded.
pub(crate) type Pending = (i32, v8::Global<v8::PromiseResolver>, v8::Global<v8::Value>, bool);

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>) {
    scope.set_wasm_async_resolve_promise_callback(resolve_later);
}

unsafe extern "C" fn resolve_later(
    _isolate: v8::UnsafeRawIsolatePtr,
    context: v8::Local<v8::Context>,
    resolver: v8::Local<v8::PromiseResolver>,
    result: v8::Local<v8::Value>,
    success: v8::WasmAsyncSuccess,
) {
    v8::callback_scope!(unsafe scope, context);
    let global = context.global(scope);
    let realm = v8::String::new(scope, "__csimRealmId")
        .and_then(|key| global.get(scope, key.into()))
        .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())
        .and_then(|f| f.call(scope, global.into(), &[]))
        .and_then(|id| id.int32_value(scope))
        .unwrap_or(0);
    let pending = (realm, v8::Global::new(scope, resolver), v8::Global::new(scope, result), success == v8::WasmAsyncSuccess::Success);
    let d = dom(scope);
    d.next_wasm_resolution = d.next_wasm_resolution.wrapping_add(1);
    let id = d.next_wasm_resolution;
    d.wasm_resolutions.insert(id, pending);
    let data = v8::Integer::new_from_unsigned(scope, id).into();
    let queued = v8::Function::builder(settle).data(data).build(scope).and_then(|task| {
        let key = v8::String::new(scope, "__csimSetTimeout")?;
        let queue = v8::Local::<v8::Function>::try_from(global.get(scope, key.into())?).ok()?;
        queue.call(scope, global.into(), &[task.into()])
    });
    // (…a realm with no event loop of the bindings' — none to queue on — settles it now)
    if queued.is_none() {
        settle_now(scope, id);
    }
}

// The task: the resolution settled.
fn settle(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(id) = args.data().uint32_value(scope) {
        settle_now(scope, id);
    }
}
fn settle_now(scope: &mut v8::PinScope<'_, '_>, id: u32) {
    let Some((_, resolver, value, ok)) = dom(scope).wasm_resolutions.remove(&id) else { return };
    let (resolver, value) = (v8::Local::new(scope, resolver), v8::Local::new(scope, value));
    if ok {
        resolver.resolve(scope, value);
    } else {
        resolver.reject(scope, value);
    }
}

// A realm's resolutions let go of with it (`Dom::forget_realm_objects`): its event loop never runs their tasks.
pub(crate) fn drop_realm(pending: &mut std::collections::HashMap<u32, Pending>, cid: i32) {
    pending.retain(|_, p| p.0 != cid);
}
