// CanvasGradient and CanvasPattern (HTML §4.12.5.1.8), the engine's: a gradient's kind, geometry and colour stops — kept
// sorted by offset, stable for equal ones — and a pattern's tile (a snapshot of the source image's RGBA pixels), the axes
// it repeats on, its colour space and its transform. Each is a handle on V8's C++ heap (`__dom.CanvasPaintBase`, as a
// context's drawing state is: canvas_state.rs) which its interface object keeps in its slots, and which traces that
// object back — what a fill or stroke style holding the handle reads back as — and a pattern's pixels. The rasterizer
// reads a style's paint off it (`paint_data`).

use std::cell::{RefCell, UnsafeCell};

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (canvas_state.rs's 4 the one before).
const TAG: u16 = 5;

// What marks an object as a paint's (its internal field 0).
static BRAND: u8 = 0;

// A paint's kind, by the code the rasterizer reads it as (canvas.rs `canvasDraw`'s paint).
const LINEAR: u32 = 2;
const RADIAL: u32 = 3;
const CONIC: u32 = 4;
const PATTERN: u32 = 5;

// A pattern's tile: its size, the axes it repeats on, whether its pixels are Display P3, and the transform it is
// sampled through.
#[derive(Clone, Copy)]
struct Tile {
    w: f64,
    h: f64,
    repeat_x: bool,
    repeat_y: bool,
    p3: bool,
    m: [f64; 6],
}

enum Paint {
    // A gradient's kind and geometry: linear `[x0, y0, x1, y1]`, radial `[x0, y0, r0, x1, y1, r1]`, conic
    // `[angle, x, y]`.
    Gradient(u32, Vec<f64>),
    Pattern(Tile),
}

pub(crate) struct CanvasPaintHandle {
    paint: RefCell<Option<Paint>>,
    // A gradient's colour stops: `[offset, r, g, b, a]`, sRGB bytes and alpha.
    stops: RefCell<Vec<[f64; 5]>>,
    wrapper: UnsafeCell<v8::TracedReference<v8::Object>>,
    pixels: UnsafeCell<v8::TracedReference<v8::Object>>,
}

unsafe impl GarbageCollected for CanvasPaintHandle {
    fn trace(&self, visitor: &mut Visitor) {
        for r in [&self.wrapper, &self.pixels] {
            // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
            visitor.trace(unsafe { &*r.get() });
        }
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"CanvasPaintHandle"
    }
}

impl CanvasPaintHandle {
    // Its interface object: what a style holding it reads back as.
    pub(crate) fn wrapper<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        // SAFETY: the main thread reads the reference.
        unsafe { (*self.wrapper.get()).get(scope) }
    }
}

// What the rasterizer paints with for `paint` (canvas.rs `canvasDraw`'s paint): a gradient's kind and geometry, then its
// stops' count and each stop; a pattern's tile size, the axes it repeats on, its colour space and its transform — and
// its tile's pixels. None for an object that is no paint.
pub(crate) fn paint_data<'s>(scope: &mut v8::PinScope<'s, '_>, paint: v8::Local<'_, v8::Object>) -> Option<(Vec<f64>, Option<v8::Local<'s, v8::Object>>)> {
    let h = handle(scope, paint.into())?;
    let data = match h.paint.borrow().as_ref()? {
        Paint::Gradient(kind, geometry) => {
            let stops = h.stops.borrow();
            let mut data = vec![f64::from(*kind)];
            data.extend_from_slice(geometry);
            data.push(stops.len() as f64);
            data.extend(stops.iter().flatten());
            return Some((data, None));
        }
        Paint::Pattern(t) => {
            let mut data = vec![f64::from(PATTERN), t.w, t.h, f64::from(u8::from(t.repeat_x)), f64::from(u8::from(t.repeat_y)), f64::from(u8::from(t.p3))];
            data.extend_from_slice(&t.m);
            data
        }
    };
    // SAFETY: the main thread reads the reference.
    let pixels = unsafe { (*h.pixels.get()).get(scope) };
    Some((data, pixels))
}

// The constructor a paint's handle object is made with (`__dom.CanvasPaintBase`): branded, a wrapper of a fresh handle.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = CanvasPaintHandle {
        paint: RefCell::new(None),
        stops: RefCell::new(Vec::new()),
        wrapper: UnsafeCell::new(v8::TracedReference::empty()),
        pixels: UnsafeCell::new(v8::TracedReference::empty()),
    };
    let heap = scope.get_cpp_heap().expect("CanvasPaintBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, CanvasPaintHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no paint's object (the brand first: `unwrap` reads garbage from
// an object it never wrapped).
pub(crate) fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h CanvasPaintHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a CanvasPaintHandle under TAG; the handle lives
    // while its object, the argument, does — through the op that asks.
    unsafe { v8::Object::unwrap::<TAG, CanvasPaintHandle>(scope, obj).map(|p| &*(p.as_ref() as *const CanvasPaintHandle)) }
}

// `__dom.CanvasPaintBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).canvas_paint_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "CanvasPaintBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).canvas_paint_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "CanvasPaintBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "canvasGradientInit", canvas_gradient_init, context_id);
    crate::dom::register(scope, ns, "canvasPatternInit", canvas_pattern_init, context_id);
    crate::dom::register(scope, ns, "canvasAddColorStop", canvas_add_color_stop, context_id);
    crate::dom::register(scope, ns, "canvasPatternTransform", canvas_pattern_transform, context_id);
}

// A paint's interface object, traced by its handle.
fn own(scope: &mut v8::PinScope<'_, '_>, h: &CanvasPaintHandle, wrapper: v8::Local<'_, v8::Value>) {
    let wrapper = v8::Local::<v8::Object>::try_from(wrapper).ok();
    // SAFETY: the main thread writes the reference.
    unsafe { (*h.wrapper.get()).reset(scope, wrapper) };
}

// __dom.canvasGradientInit(paint, wrapper, kind, …geometry) — a gradient, its interface object `wrapper`: of `kind` (2
// linear, 3 radial, 4 conic) and its geometry (`Paint::Gradient`), no stops yet.
fn canvas_gradient_init(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    own(scope, h, args.get(1));
    let kind = args.get(2).uint32_value(scope).unwrap_or(LINEAR);
    let n = match kind {
        RADIAL => 6,
        CONIC => 3,
        _ => 4,
    };
    let geometry = (0..n).map(|k| args.get(3 + k).number_value(scope).unwrap_or(f64::NAN)).collect();
    *h.paint.borrow_mut() = Some(Paint::Gradient(kind, geometry));
}

// What a `createPattern` repetition repeats on, by the code the bindings name it with: `repeat`, `repeat-x`,
// `repeat-y`, `no-repeat`.
const REPEATS: [(bool, bool); 4] = [(true, true), (true, false), (false, true), (false, false)];

// __dom.canvasPatternInit(paint, wrapper, pixels, w, h, repetition, p3) — a pattern, its interface object `wrapper`: its
// `w` × `h` tile `pixels` (its own copy, a Display P3 one where `p3`), repeating as `repetition` says (`REPEATS`), under
// the identity until its transform is set.
fn canvas_pattern_init(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    own(scope, h, args.get(1));
    let pixels = v8::Local::<v8::Object>::try_from(args.get(2)).ok();
    // SAFETY: the main thread writes the reference.
    unsafe { (*h.pixels.get()).reset(scope, pixels) };
    let [w, hgt] = [3, 4].map(|k| args.get(k).number_value(scope).unwrap_or(0.0));
    let (repeat_x, repeat_y) = REPEATS[args.get(5).uint32_value(scope).unwrap_or(0).min(3) as usize];
    let p3 = args.get(6).is_true();
    *h.paint.borrow_mut() = Some(Paint::Pattern(Tile { w, h: hgt, repeat_x, repeat_y, p3, m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] }));
}

// Why `addColorStop` refuses a stop.
const OFFSET_OUT_OF_RANGE: u32 = 1;
const NO_COLOR: u32 = 2;

// __dom.canvasAddColorStop(gradient, offset, color) -> 0, or why it refuses the stop: an offset outside [0, 1]
// (`OFFSET_OUT_OF_RANGE`, an IndexSizeError), a colour that does not parse (`NO_COLOR`, a SyntaxError). The stop goes
// after every one at its offset or before it. A gradient isn't associated with an element, so a `currentColor` stop is
// the initial colour, opaque black — not the canvas element's `color`.
fn canvas_add_color_stop(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let offset = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    if !(0.0..=1.0).contains(&offset) {
        return rv.set_uint32(OFFSET_OUT_OF_RANGE);
    }
    let text = args.get(2).to_rust_string_lossy(scope);
    let cid = crate::dom::realm_id(scope, &args);
    let Some(color) = crate::canvas_state::parse_color(scope, cid, &text, "black") else { return rv.set_uint32(NO_COLOR) };
    let [r, g, b] = color.rgb.map(f64::from);
    let mut stops = h.stops.borrow_mut();
    let at = stops.iter().rposition(|s| s[0] <= offset).map_or(0, |i| i + 1);
    stops.insert(at, [offset, r, g, b, color.a]);
    rv.set_uint32(0);
}

// __dom.canvasPatternTransform(pattern, a, b, c, d, e, f) — the transform a pattern is sampled through; one with a
// member that is not finite leaves it as it was.
fn canvas_pattern_transform(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let m: [f64; 6] = std::array::from_fn(|k| args.get(k as i32 + 1).number_value(scope).unwrap_or(f64::NAN));
    if let (true, Some(Paint::Pattern(tile))) = (m.iter().all(|v| v.is_finite()), h.paint.borrow_mut().as_mut()) {
        tile.m = m;
    }
}
