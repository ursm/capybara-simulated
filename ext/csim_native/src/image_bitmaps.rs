// An ImageBitmap's state (HTML §8.10.1): its RGBA pixels (row-major; a wide-profile source's Display P3 rendering
// beside them), its size, its colour space, whether a cross-origin source tainted it, and whether it is closed
// ([[Detached]]: an unusable image source, of no size and no pixels) — on a handle the bindings' object holds
// (`__dom.ImageBitmapStateBase`, as a canvas context's state is: canvas_state.rs), which lives as long as that object
// does, wherever a script took it. Its pixels are the arrays it was made of, traced by the handle — the same views
// handed to every draw, never copied for one, and counted by the collector as any array is.

use std::cell::{Cell, UnsafeCell};

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (event_source_state.rs' 15).
const TAG: u16 = 16;

// What marks an object as a bitmap state's (its internal field 0).
static BRAND: u8 = 0;

pub(crate) struct BitmapHandle {
    // Its sRGB pixels and its Display P3 ones (Uint8ClampedArrays, or empty: none).
    pixels: [UnsafeCell<v8::TracedReference<v8::Object>>; 2],
    size: Cell<[u32; 2]>,
    display_p3: Cell<bool>,
    tainted: Cell<bool>,
    closed: Cell<bool>,
}

unsafe impl GarbageCollected for BitmapHandle {
    fn trace(&self, visitor: &mut Visitor) {
        for r in &self.pixels {
            // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
            visitor.trace(unsafe { &*r.get() });
        }
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"BitmapHandle"
    }
}

impl BitmapHandle {
    fn pixels<'s>(&self, scope: &mut v8::PinScope<'s, '_>, which: usize) -> v8::Local<'s, v8::Value> {
        // SAFETY: the main thread reads the reference; nothing else writes it meanwhile.
        unsafe { (*self.pixels[which].get()).get(scope) }.map_or_else(|| v8::null(scope).into(), Into::into)
    }
}

// `new __dom.ImageBitmapStateBase(pixels | null, width, height, pixelsP3 | null, displayP3, tainted)` — a bitmap of those
// pixels (byte views, which it holds from now on), that size and colour space, tainted or not.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let view = |i: i32| v8::Local::<v8::ArrayBufferView>::try_from(args.get(i)).ok().map(v8::Local::<v8::Object>::from);
    let (srgb, p3) = (view(0), view(3));
    let size = [1, 2].map(|i| args.get(i).uint32_value(scope).unwrap_or(0));
    let handle = BitmapHandle {
        pixels: [(); 2].map(|_| UnsafeCell::new(v8::TracedReference::empty())),
        size: Cell::new(size),
        display_p3: Cell::new(args.get(4).is_true()),
        tainted: Cell::new(args.get(5).is_true()),
        closed: Cell::new(false),
    };
    for (slot, pixels) in handle.pixels.iter().zip([srgb, p3]) {
        // SAFETY: the reference is the handle's own, written before anything else can read it.
        unsafe { (*slot.get()).reset(scope, pixels) };
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let heap = scope.get_cpp_heap().expect("ImageBitmapStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, BitmapHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no bitmap state's object (the brand first: `unwrap` reads
// garbage from an object it never wrapped).
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h BitmapHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a BitmapHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let ptr = unsafe { v8::Object::unwrap::<TAG, BitmapHandle>(scope, obj)? };
    Some(unsafe { &*(ptr.as_ref() as *const BitmapHandle) })
}

// `__dom.ImageBitmapStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).image_bitmap_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "ImageBitmapStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).image_bitmap_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "ImageBitmapStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "imageBitmapState", state_op, context_id);
    crate::dom::register(scope, ns, "imageBitmapSize", size_op, context_id);
    crate::dom::register(scope, ns, "imageBitmapClose", close_op, context_id);
}

// __dom.imageBitmapState(state) -> [pixels | null, width, height, pixelsP3 | null, displayP3, tainted, closed]: the
// bitmap as a draw, a clone or a pattern reads it — its pixels the arrays it holds.
fn state_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_null() };
    let [w, h_] = h.size.get();
    let items = [
        h.pixels(scope, 0),
        v8::Integer::new_from_unsigned(scope, w).into(),
        v8::Integer::new_from_unsigned(scope, h_).into(),
        h.pixels(scope, 1),
        v8::Boolean::new(scope, h.display_p3.get()).into(),
        v8::Boolean::new(scope, h.tainted.get()).into(),
        v8::Boolean::new(scope, h.closed.get()).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.imageBitmapSize(state, axis) -> its width (axis 0) or height (1): 0 once closed.
fn size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_uint32(0) };
    let axis = usize::from(args.get(1).uint32_value(scope) == Some(1));
    rv.set_uint32(h.size.get()[axis]);
}

// __dom.imageBitmapClose(state) — the bitmap closed: its pixels let go of, its size none (`close()`, a transfer).
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    for slot in &h.pixels {
        // SAFETY: the main thread writes the reference, as TracedReference allows between marking steps.
        unsafe { (*slot.get()).reset(scope, None) };
    }
    h.size.set([0, 0]);
    h.closed.set(true);
}
