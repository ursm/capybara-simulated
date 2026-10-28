// An OffscreenCanvas's own state (HTML §4.12.5.3): its width and height — its bitmap's, which a context draws into
// (canvas_state.rs) — and whether a transfer detached it ([[Detached]]: of no size, and no member of it may run), on a
// handle the bindings' object holds (`__dom.OffscreenCanvasStateBase`, as an ImageBitmap's state is: image_bitmaps.rs),
// which lives as long as that object does.

use std::cell::Cell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (font_face_set.rs' 20).
const TAG: u16 = 21;

// What marks an object as an OffscreenCanvas state's (its internal field 0).
static BRAND: u8 = 0;

pub(crate) struct OffscreenHandle {
    size: Cell<[u32; 2]>,
    detached: Cell<bool>,
}

unsafe impl GarbageCollected for OffscreenHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"OffscreenHandle"
    }
}

impl OffscreenHandle {
    // Its size: none once detached.
    pub(crate) fn size(&self) -> [u32; 2] {
        self.size.get()
    }
    pub(crate) fn detached(&self) -> bool {
        self.detached.get()
    }
}

// `new __dom.OffscreenCanvasStateBase(width, height)` — an OffscreenCanvas of that size, not detached.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let size = [0, 1].map(|i| args.get(i).uint32_value(scope).unwrap_or(0));
    let handle = OffscreenHandle { size: Cell::new(size), detached: Cell::new(false) };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let heap = scope.get_cpp_heap().expect("OffscreenCanvasStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, OffscreenHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no OffscreenCanvas state's object (the brand first: `unwrap`
// reads garbage from an object it never wrapped).
pub(crate) fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h OffscreenHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped an OffscreenHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let ptr = unsafe { v8::Object::unwrap::<TAG, OffscreenHandle>(scope, obj)? };
    Some(unsafe { &*(ptr.as_ref() as *const OffscreenHandle) })
}

// `__dom.OffscreenCanvasStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).offscreen_canvas_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "OffscreenCanvasStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).offscreen_canvas_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "OffscreenCanvasStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "offscreenCanvasSize", size_op, context_id);
    crate::dom::register(scope, ns, "offscreenCanvasResize", resize_op, context_id);
    crate::dom::register(scope, ns, "offscreenCanvasDetached", detached_op, context_id);
    crate::dom::register(scope, ns, "offscreenCanvasDetach", detach_op, context_id);
}

// __dom.offscreenCanvasSize(state, axis) -> its width (axis 0) or height (1).
fn size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_uint32(0) };
    let axis = usize::from(args.get(1).uint32_value(scope) == Some(1));
    rv.set_uint32(h.size.get()[axis]);
}

// __dom.offscreenCanvasResize(state, axis, value): its width (axis 0) or height (1) set — the bindings reset its bitmap.
fn resize_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let axis = usize::from(args.get(1).uint32_value(scope) == Some(1));
    let mut size = h.size.get();
    size[axis] = args.get(2).uint32_value(scope).unwrap_or(0);
    h.size.set(size);
}

// __dom.offscreenCanvasDetached(state) -> whether a transfer detached it.
fn detached_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(handle(scope, args.get(0)).is_some_and(|h| h.detached.get()));
}

// __dom.offscreenCanvasDetach(state): detached by its transfer — of no size from now on.
fn detach_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    h.detached.set(true);
    h.size.set([0, 0]);
}
