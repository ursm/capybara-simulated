// A 2D context's drawing state (HTML §4.12.5.1.1 "the canvas state"): the current transformation matrix, the clipping
// region, the compositing, line, shadow, fill / stroke and text styles — each attribute's setter ignoring a value out of
// its range as the spec has it — and the stack `save()` pushes it onto and `restore()` pops it off. A context's object
// holds a handle on V8's C++ heap (`__dom.CanvasStateBase`, as a range's does: ranges.rs) that owns the state; the paint
// objects of its fill and stroke styles — a gradient, a pattern, the same object reading back — and its clip mask are
// references it traces, the current state's and each saved one's. Drawing reads it here (canvas.rs `canvas_draw`, the
// shapes and paths of canvas_path.rs): the bindings pack none of it.

use std::cell::{RefCell, UnsafeCell};

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, a range's 2, an iterator's 3).
const TAG: u16 = 4;

// What marks an object as a canvas state's (its internal field 0).
static BRAND: u8 = 0;

// The drawing-state attributes, by the code the bindings name each with — CanvasRenderingContext2D's in the order its
// IDL lists them (canvas.js `CONTEXT_ATTRIBUTES`).
pub(crate) const GLOBAL_ALPHA: u32 = 0;
pub(crate) const COMPOSITE: u32 = 1;
pub(crate) const SMOOTHING: u32 = 2;
pub(crate) const SMOOTHING_QUALITY: u32 = 3;
pub(crate) const STROKE_STYLE: u32 = 4;
pub(crate) const FILL_STYLE: u32 = 5;
pub(crate) const SHADOW_OFFSET_X: u32 = 6;
pub(crate) const SHADOW_OFFSET_Y: u32 = 7;
pub(crate) const SHADOW_BLUR: u32 = 8;
pub(crate) const SHADOW_COLOR: u32 = 9;
pub(crate) const FILTER: u32 = 10;
pub(crate) const LINE_WIDTH: u32 = 11;
pub(crate) const LINE_CAP: u32 = 12;
pub(crate) const LINE_JOIN: u32 = 13;
pub(crate) const MITER_LIMIT: u32 = 14;
pub(crate) const LINE_DASH_OFFSET: u32 = 15;
pub(crate) const LANG: u32 = 16;
pub(crate) const FONT: u32 = 17;
pub(crate) const TEXT_ALIGN: u32 = 18;
pub(crate) const TEXT_BASELINE: u32 = 19;
pub(crate) const DIRECTION: u32 = 20;
pub(crate) const LETTER_SPACING: u32 = 21;
pub(crate) const FONT_KERNING: u32 = 22;
pub(crate) const FONT_STRETCH: u32 = 23;
pub(crate) const FONT_VARIANT_CAPS: u32 = 24;
pub(crate) const TEXT_RENDERING: u32 = 25;
pub(crate) const WORD_SPACING: u32 = 26;

// Each enumerated attribute's keywords — a setter takes one exactly (no case folding, no trimming) and ignores anything
// else — its value the index of one.
pub(crate) const COMPOSITE_OPS: [&str; 28] = [
    "source-over", "source-in", "source-out", "source-atop", "destination-over", "destination-in", "destination-out",
    "destination-atop", "copy", "xor", "lighter", "plus-lighter", "clear", "multiply", "screen", "overlay", "darken",
    "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation",
    "color", "luminosity",
];
const QUALITIES: [&str; 3] = ["low", "medium", "high"];
pub(crate) const CAPS: [&str; 3] = ["butt", "round", "square"];
pub(crate) const JOINS: [&str; 3] = ["miter", "round", "bevel"];
pub(crate) const ALIGNS: [&str; 5] = ["start", "end", "left", "right", "center"];
pub(crate) const BASELINES: [&str; 6] = ["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"];
pub(crate) const DIRECTIONS: [&str; 3] = ["ltr", "rtl", "inherit"];
pub(crate) const KERNINGS: [&str; 3] = ["auto", "normal", "none"];
const STRETCHES: [&str; 9] = [
    "normal", "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "semi-expanded", "expanded",
    "extra-expanded", "ultra-expanded",
];
pub(crate) const VARIANT_CAPS: [&str; 7] = ["normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps"];
const RENDERINGS: [&str; 4] = ["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"];
// The system font keywords, which name the platform's UI font: not modelled, one concrete default stands for all.
const SYSTEM_FONTS: [&str; 6] = ["caption", "icon", "menu", "message-box", "small-caption", "status-bar"];

// A colour as a canvas keeps it: its sRGB bytes and alpha — and, for one written in a CSS Color 4 form, the
// serialization it reads back as.
#[derive(Clone)]
pub(crate) struct Color {
    pub(crate) rgb: [u8; 3],
    pub(crate) a: f64,
    css: Option<String>,
}

impl Color {
    const fn opaque_black() -> Color {
        Color { rgb: [0, 0, 0], a: 1.0, css: None }
    }
    const fn transparent_black() -> Color {
        Color { rgb: [0, 0, 0], a: 0.0, css: None }
    }
    // HTML "serialization of a color" as a canvas writes it: a Color 4 one as written; an opaque one (its alpha byte 255)
    // `#rrggbb`; else `rgba(r, g, b, a)`, its alpha the shortest decimal of its byte (Chrome and Firefox: `#ff000080`
    // reads `rgba(255, 0, 0, 0.5)`).
    fn serialize(&self) -> String {
        if let Some(css) = &self.css {
            return css.clone();
        }
        let [r, g, b] = self.rgb;
        let byte = (self.a * 255.0).round();
        if byte >= 255.0 {
            return format!("#{r:02x}{g:02x}{b:02x}");
        }
        format!("rgba({r}, {g}, {b}, {})", crate::numbers::to_js_string(serialize_alpha(byte / 255.0)))
    }
}

// An alpha as CSS serializes one: the fewest decimals (up to two, else three) that round to the same byte.
fn serialize_alpha(a: f64) -> f64 {
    let byte = (a * 255.0).round();
    for places in [1, 2] {
        let candidate: f64 = format!("{a:.places$}").parse().unwrap_or(a);
        if (candidate * 255.0).round() == byte {
            return candidate;
        }
    }
    format!("{a:.3}").parse().unwrap_or(a)
}

// The `font`, as its setter computed it (cssom_decl.rs `canvas_font`).
#[derive(Clone)]
pub(crate) struct Font {
    pub(crate) css: String,
    pub(crate) px: f64,
    pub(crate) weight: f64,
    pub(crate) slant: u8,
    pub(crate) small_caps: bool,
    pub(crate) family: String,
}

// The state but the objects it traces.
#[derive(Clone)]
pub(crate) struct State {
    pub(crate) m: [f64; 6],
    pub(crate) alpha: f64,
    pub(crate) composite: u8,
    pub(crate) smoothing: bool,
    smoothing_quality: u8,
    pub(crate) line_width: f64,
    pub(crate) cap: u8,
    pub(crate) join: u8,
    pub(crate) miter: f64,
    pub(crate) dash: Vec<f64>,
    pub(crate) dash_offset: f64,
    pub(crate) shadow_blur: f64,
    pub(crate) shadow_x: f64,
    pub(crate) shadow_y: f64,
    pub(crate) shadow: Color,
    pub(crate) fill: Color,
    pub(crate) stroke: Color,
    filter: String,
    lang: String,
    pub(crate) font: Font,
    pub(crate) align: u8,
    pub(crate) baseline: u8,
    pub(crate) direction: u8,
    pub(crate) letter_spacing: String,
    pub(crate) word_spacing: String,
    pub(crate) kerning: u8,
    stretch: u8,
    pub(crate) variant_caps: u8,
    rendering: u8,
}

impl Default for State {
    fn default() -> State {
        State {
            m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            alpha: 1.0,
            composite: 0,
            smoothing: true,
            smoothing_quality: 0,
            line_width: 1.0,
            cap: 0,
            join: 0,
            miter: 10.0,
            dash: Vec::new(),
            dash_offset: 0.0,
            shadow_blur: 0.0,
            shadow_x: 0.0,
            shadow_y: 0.0,
            shadow: Color::transparent_black(),
            fill: Color::opaque_black(),
            stroke: Color::opaque_black(),
            filter: "none".into(),
            lang: "inherit".into(),
            font: default_font(),
            align: 0,
            baseline: 3,
            direction: 2,
            letter_spacing: "0px".into(),
            word_spacing: "0px".into(),
            kerning: 0,
            stretch: 0,
            variant_caps: 0,
            rendering: 0,
        }
    }
}

fn default_font() -> Font {
    let f = crate::cssom_decl::canvas_font("10px sans-serif", f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    match f {
        Some(f) => Font { css: f.css, px: f.px, weight: f.weight, slant: f.slant, small_caps: f.small_caps, family: f.family },
        None => Font { css: "10px sans-serif".into(), px: 10.0, weight: 400.0, slant: 0, small_caps: false, family: "sans-serif".into() },
    }
}

// The objects a state traces: its fill style's and stroke style's (a gradient or a pattern, else none) and its clip
// mask (none: no clip).
pub(crate) const FILL: usize = 0;
pub(crate) const STROKE: usize = 1;
pub(crate) const CLIP: usize = 2;

pub(crate) struct CanvasStateHandle {
    state: RefCell<State>,
    refs: [UnsafeCell<v8::TracedReference<v8::Object>>; 3],
    // The states `save()` pushed, each with whether it has objects — those it has three a state in one array on V8's
    // heap, which the handle traces through a reference of its own: the collector reads only fixed fields of the
    // handle, whatever the stack does.
    stack: RefCell<Vec<(State, bool)>>,
    saved: UnsafeCell<v8::TracedReference<v8::Object>>,
}

unsafe impl GarbageCollected for CanvasStateHandle {
    fn trace(&self, visitor: &mut Visitor) {
        for r in self.refs.iter().chain([&self.saved]) {
            // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
            visitor.trace(unsafe { &*r.get() });
        }
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"CanvasStateHandle"
    }
}

impl CanvasStateHandle {
    pub(crate) fn state(&self) -> std::cell::Ref<'_, State> {
        self.state.borrow()
    }
    // The object the current state traces in `slot` (`FILL`, `STROKE`, `CLIP`).
    pub(crate) fn object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, slot: usize) -> Option<v8::Local<'s, v8::Object>> {
        // SAFETY: the main thread reads the reference; nothing else writes it meanwhile.
        unsafe { (*self.refs[slot].get()).get(scope) }
    }
    pub(crate) fn set_object(&self, scope: &mut v8::PinScope<'_, '_>, slot: usize, object: Option<v8::Local<'_, v8::Object>>) {
        // SAFETY: as `object`.
        unsafe { (*self.refs[slot].get()).reset(scope, object) };
    }
    // The array the saved states' objects are in, made where there is none yet.
    fn saved<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Array> {
        // SAFETY: the main thread reads and writes the reference.
        let kept = unsafe { (*self.saved.get()).get(scope) }.and_then(|o| v8::Local::<v8::Array>::try_from(o).ok());
        kept.unwrap_or_else(|| {
            let made = v8::Array::new(scope, 0);
            // SAFETY: as above.
            unsafe { (*self.saved.get()).reset(scope, Some(made.into())) };
            made
        })
    }
    // "Push a copy of the current drawing state onto the drawing state stack."
    fn save(&self, scope: &mut v8::PinScope<'_, '_>) {
        let objects = [0, 1, 2].map(|slot| self.object(scope, slot));
        // (…none kept for a state with no paint object and no clip, as most are)
        let any = objects.iter().any(Option::is_some);
        if any {
            let saved = self.saved(scope);
            // (…own data properties, whatever setters a page put on `Array.prototype`)
            for object in objects {
                let object: v8::Local<'_, v8::Value> = object.map_or_else(|| v8::null(scope).into(), Into::into);
                let index = v8::Integer::new_from_unsigned(scope, saved.length()).to_string(scope).expect("an index");
                saved.create_data_property(scope, index.into(), object);
            }
        }
        self.stack.borrow_mut().push((self.state.borrow().clone(), any));
    }
    // "Pop the top entry in the drawing state stack, and reset the drawing state it describes" — none: nothing.
    fn restore(&self, scope: &mut v8::PinScope<'_, '_>) {
        let Some((state, any)) = self.stack.borrow_mut().pop() else { return };
        *self.state.borrow_mut() = state;
        if !any {
            for slot in 0..3 {
                self.set_object(scope, slot, None);
            }
            return;
        }
        let saved = self.saved(scope);
        let base = saved.length().saturating_sub(3);
        for slot in 0..3 {
            let object = saved.get_index(scope, base + slot as u32).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok());
            self.set_object(scope, slot, object);
        }
        let length = v8::String::new(scope, "length").expect("a short string");
        let shorter = v8::Integer::new_from_unsigned(scope, base);
        saved.set(scope, length.into(), shorter.into());
    }
    // "Reset the rendering context to its default state": the stack emptied, every attribute its default, no clip.
    fn reset(&self, scope: &mut v8::PinScope<'_, '_>) {
        self.stack.borrow_mut().clear();
        *self.state.borrow_mut() = State::default();
        for slot in 0..3 {
            self.set_object(scope, slot, None);
        }
        // SAFETY: the main thread writes the reference.
        unsafe { (*self.saved.get()).reset(scope, None) };
    }
}

// The constructor a context's state object is made with (`__dom.CanvasStateBase`): branded, a wrapper of a fresh
// handle in the default state.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = CanvasStateHandle {
        state: RefCell::new(State::default()),
        refs: [(); 3].map(|_| UnsafeCell::new(v8::TracedReference::empty())),
        stack: RefCell::new(Vec::new()),
        saved: UnsafeCell::new(v8::TracedReference::empty()),
    };
    let heap = scope.get_cpp_heap().expect("CanvasStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, CanvasStateHandle>(scope, obj, &ptr);
    }
}

// The handle `value` wraps, or None for anything that is no canvas state's object (the brand first: `unwrap` reads
// garbage from an object it never wrapped).
pub(crate) fn handle_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<v8::cppgc::UnsafePtr<CanvasStateHandle>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a CanvasStateHandle under TAG.
    unsafe { v8::Object::unwrap::<TAG, CanvasStateHandle>(scope, obj) }
}

// `__dom.CanvasStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).canvas_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "CanvasStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).canvas_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "CanvasStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "canvasGet", canvas_get, context_id);
    crate::dom::register(scope, ns, "canvasSet", canvas_set, context_id);
    crate::dom::register(scope, ns, "canvasStack", canvas_stack, context_id);
    crate::dom::register(scope, ns, "canvasTransform", canvas_transform, context_id);
    crate::dom::register(scope, ns, "canvasLineDash", canvas_line_dash, context_id);
    crate::dom::register(scope, ns, "canvasObject", canvas_object, context_id);
    crate::dom::register(scope, ns, "canvasFontFace", canvas_font_face, context_id);
}

// The handle of a state argument.
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h CanvasStateHandle> {
    // SAFETY: the handle lives while its object, the argument, does — through this op.
    handle_of(scope, value).map(|p| unsafe { &*(p.as_ref() as *const CanvasStateHandle) })
}

fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// __dom.canvasGet(state, attribute) -> the attribute's value (its code: `GLOBAL_ALPHA` …): a number, a boolean, a
// keyword, a serialization — a fill or stroke style that is an object, that object.
fn canvas_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    if let Some(obj) = match which {
        FILL_STYLE => h.object(scope, FILL),
        STROKE_STYLE => h.object(scope, STROKE),
        _ => None,
    } {
        return rv.set(obj.into());
    }
    let s = h.state();
    let keyword = |list: &[&'static str], i: u8| list.get(i as usize).copied().unwrap_or("");
    let text: String = match which {
        GLOBAL_ALPHA => return rv.set_double(s.alpha),
        SMOOTHING => return rv.set_bool(s.smoothing),
        SHADOW_OFFSET_X => return rv.set_double(s.shadow_x),
        SHADOW_OFFSET_Y => return rv.set_double(s.shadow_y),
        SHADOW_BLUR => return rv.set_double(s.shadow_blur),
        LINE_WIDTH => return rv.set_double(s.line_width),
        MITER_LIMIT => return rv.set_double(s.miter),
        LINE_DASH_OFFSET => return rv.set_double(s.dash_offset),
        COMPOSITE => keyword(&COMPOSITE_OPS, s.composite).into(),
        SMOOTHING_QUALITY => keyword(&QUALITIES, s.smoothing_quality).into(),
        STROKE_STYLE => s.stroke.serialize(),
        FILL_STYLE => s.fill.serialize(),
        SHADOW_COLOR => s.shadow.serialize(),
        FILTER => s.filter.clone(),
        LINE_CAP => keyword(&CAPS, s.cap).into(),
        LINE_JOIN => keyword(&JOINS, s.join).into(),
        LANG => s.lang.clone(),
        FONT => s.font.css.clone(),
        TEXT_ALIGN => keyword(&ALIGNS, s.align).into(),
        TEXT_BASELINE => keyword(&BASELINES, s.baseline).into(),
        DIRECTION => keyword(&DIRECTIONS, s.direction).into(),
        LETTER_SPACING => s.letter_spacing.clone(),
        FONT_KERNING => keyword(&KERNINGS, s.kerning).into(),
        FONT_STRETCH => keyword(&STRETCHES, s.stretch).into(),
        FONT_VARIANT_CAPS => keyword(&VARIANT_CAPS, s.variant_caps).into(),
        TEXT_RENDERING => keyword(&RENDERINGS, s.rendering).into(),
        WORD_SPACING => s.word_spacing.clone(),
        _ => return,
    };
    drop(s);
    rv.set(string(scope, &text));
}

// A colour of `text` as a canvas style takes it (style.rs `parse_color`), `currentColor` resolving to `current`; None
// for no colour.
fn parse_color(scope: &mut v8::PinScope<'_, '_>, cid: i32, text: &str, current: &str) -> Option<Color> {
    use style_traits::ToCss;
    let d = crate::dom::dom(scope);
    let arena = d.arena.enter(cid);
    let color = crate::style::parse_color(d.styles.get(&cid), arena, text, current)?;
    let srgb = color.to_color_space(style::color::ColorSpace::Srgb);
    let [r, g, b, _] = *srgb.raw_components();
    let byte = |c: f32| (f64::from(c).clamp(0.0, 1.0) * 255.0).round() as u8;
    let css = (!color.is_legacy_syntax()).then(|| color.to_css_string());
    Some(Color { rgb: [byte(r), byte(g), byte(b)], a: f64::from(color.alpha).clamp(0.0, 1.0), css })
}

// __dom.canvasSet(state, attribute, value, extra) — the attribute set, where its setter takes the value (converted as
// its IDL type converts it): a number in its range, one of its keywords, a colour that parses (`extra` what
// `currentColor` is), a fill or stroke style's gradient or pattern (`extra` true: the bindings tell one), a `font` that
// parses (`extra` the bases of its relative units: `[em, rem, lh, rlh]`, or undefined for none), a letter or word
// spacing that is a length; else nothing.
fn canvas_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    let extra = args.get(3);
    // (…a style's paint object: traced, the colour it had kept for a colour set again)
    if matches!(which, FILL_STYLE | STROKE_STYLE) && extra.is_true() {
        let object = v8::Local::<v8::Object>::try_from(value).ok();
        h.set_object(scope, if which == FILL_STYLE { FILL } else { STROKE }, object);
        return;
    }
    let text = || value.to_rust_string_lossy(scope);
    let keyword = |list: &[&str], text: &str| list.iter().position(|k| *k == text).map(|i| i as u8);
    match which {
        FILL_STYLE | STROKE_STYLE | SHADOW_COLOR => {
            let (text, current) = (value.to_rust_string_lossy(scope), extra.to_rust_string_lossy(scope));
            let current = if extra.is_string() { current } else { "black".into() };
            let cid = crate::dom::realm_id(scope, &args);
            let Some(color) = parse_color(scope, cid, &text, &current) else { return };
            let mut s = h.state.borrow_mut();
            match which {
                FILL_STYLE => s.fill = color,
                STROKE_STYLE => s.stroke = color,
                _ => s.shadow = color,
            }
            drop(s);
            if which != SHADOW_COLOR {
                h.set_object(scope, if which == FILL_STYLE { FILL } else { STROKE }, None);
            }
        }
        FONT => {
            let text = text();
            let bases = crate::dom::f64_arg(extra).to_vec();
            let base = |i: usize| bases.get(i).copied().unwrap_or(f64::NAN);
            let raw = text.trim();
            let parsed = if SYSTEM_FONTS.iter().any(|k| k.eq_ignore_ascii_case(raw)) {
                crate::cssom_decl::canvas_font("16px sans-serif", f64::NAN, f64::NAN, f64::NAN, f64::NAN)
            } else {
                crate::cssom_decl::canvas_font(raw, base(0), base(1), base(2), base(3))
            };
            if let Some(f) = parsed {
                h.state.borrow_mut().font = Font { css: f.css, px: f.px, weight: f.weight, slant: f.slant, small_caps: f.small_caps, family: f.family };
            }
        }
        LETTER_SPACING | WORD_SPACING => {
            let Some((css, _)) = crate::cssom_decl::canvas_spacing(&text(), f64::NAN, f64::NAN) else { return };
            let mut s = h.state.borrow_mut();
            if which == LETTER_SPACING { s.letter_spacing = css } else { s.word_spacing = css }
        }
        FILTER => h.state.borrow_mut().filter = text(),
        LANG => h.state.borrow_mut().lang = text(),
        SMOOTHING => h.state.borrow_mut().smoothing = value.boolean_value(scope),
        _ => {
            // (…converted only here: a style's paint object is no number, and its `valueOf` is the page's)
            let number = value.number_value(scope).unwrap_or(f64::NAN);
            let finite = number.is_finite();
            let code = match which {
                COMPOSITE => keyword(&COMPOSITE_OPS, &text()),
                SMOOTHING_QUALITY => keyword(&QUALITIES, &text()),
                LINE_CAP => keyword(&CAPS, &text()),
                LINE_JOIN => keyword(&JOINS, &text()),
                TEXT_ALIGN => keyword(&ALIGNS, &text()),
                TEXT_BASELINE => keyword(&BASELINES, &text()),
                DIRECTION => keyword(&DIRECTIONS, &text()),
                FONT_KERNING => keyword(&KERNINGS, &text()),
                FONT_STRETCH => keyword(&STRETCHES, &text()),
                FONT_VARIANT_CAPS => keyword(&VARIANT_CAPS, &text()),
                TEXT_RENDERING => keyword(&RENDERINGS, &text()),
                _ => None,
            };
            let mut s = h.state.borrow_mut();
            match (which, code) {
                (COMPOSITE, Some(c)) => s.composite = c,
                (SMOOTHING_QUALITY, Some(c)) => s.smoothing_quality = c,
                (LINE_CAP, Some(c)) => s.cap = c,
                (LINE_JOIN, Some(c)) => s.join = c,
                (TEXT_ALIGN, Some(c)) => s.align = c,
                (TEXT_BASELINE, Some(c)) => s.baseline = c,
                (DIRECTION, Some(c)) => s.direction = c,
                (FONT_KERNING, Some(c)) => s.kerning = c,
                (FONT_STRETCH, Some(c)) => s.stretch = c,
                (FONT_VARIANT_CAPS, Some(c)) => s.variant_caps = c,
                (TEXT_RENDERING, Some(c)) => s.rendering = c,
                (GLOBAL_ALPHA, _) if finite && (0.0..=1.0).contains(&number) => s.alpha = number,
                (SHADOW_BLUR, _) if finite && number >= 0.0 => s.shadow_blur = number,
                (SHADOW_OFFSET_X, _) if finite => s.shadow_x = number,
                (SHADOW_OFFSET_Y, _) if finite => s.shadow_y = number,
                (LINE_WIDTH, _) if finite && number > 0.0 => s.line_width = number,
                (MITER_LIMIT, _) if finite && number > 0.0 => s.miter = number,
                (LINE_DASH_OFFSET, _) if finite => s.dash_offset = number,
                _ => {}
            }
        }
    }
}

// What `canvasStack` does to a state.
const SAVE: u32 = 0;
const RESTORE: u32 = 1;
const RESET: u32 = 2;

// __dom.canvasStack(state, how) — `save()` (`SAVE`), `restore()` (`RESTORE`), or the state reset to its default
// (`RESET`: `reset()`, a canvas resized).
fn canvas_stack(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    match args.get(1).uint32_value(scope) {
        Some(SAVE) => h.save(scope),
        Some(RESTORE) => h.restore(scope),
        Some(RESET) => h.reset(scope),
        _ => {}
    }
}

// What `canvasTransform` does to the current transformation matrix.
const TRANSLATE: u32 = 0;
const SCALE: u32 = 1;
const ROTATE: u32 = 2;
const TRANSFORM: u32 = 3;
const SET: u32 = 4;
const IDENTITY: u32 = 5;
const GET: u32 = 6;

// `a` with `b` appended — `b` applied to a point first, as `transform()` post-multiplies.
pub(crate) fn multiply(a: &[f64; 6], b: &[f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

// __dom.canvasTransform(state, how, a, b, c, d, e, f) -> the matrix after (`[a, b, c, d, e, f]`) for `GET`: the CTM
// translated (`TRANSLATE` by a, b), scaled (`SCALE`), rotated (`ROTATE` by a radians), transformed by (`TRANSFORM`) or
// set to (`SET`) the matrix given, or reset (`IDENTITY`) — each a no-op where an argument it takes is not finite.
fn canvas_transform(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let how = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let v: [f64; 6] = std::array::from_fn(|i| args.get(i as i32 + 2).number_value(scope).unwrap_or(f64::NAN));
    let finite = |n: usize| v[..n].iter().all(|x| x.is_finite());
    let mut s = h.state.borrow_mut();
    match how {
        TRANSLATE if finite(2) => s.m = multiply(&s.m, &[1.0, 0.0, 0.0, 1.0, v[0], v[1]]),
        SCALE if finite(2) => s.m = multiply(&s.m, &[v[0], 0.0, 0.0, v[1], 0.0, 0.0]),
        ROTATE if finite(1) => {
            let (sin, cos) = v[0].sin_cos();
            s.m = multiply(&s.m, &[cos, sin, -sin, cos, 0.0, 0.0]);
        }
        TRANSFORM if finite(6) => s.m = multiply(&s.m, &v),
        SET if finite(6) => s.m = v,
        IDENTITY => s.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        GET => {
            let m = s.m;
            drop(s);
            return rv.set(crate::dom::f64_array(scope, &m).into());
        }
        _ => {}
    }
}

// __dom.canvasLineDash(state, segments) -> the dash list (a new array) where `segments` is undefined; else
// `setLineDash(segments)` (a Float64Array of them): ignored where one is negative or not finite, an odd list doubled.
fn canvas_line_dash(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let given = args.get(1);
    if given.is_undefined() {
        let dash = h.state().dash.clone();
        let items: Vec<v8::Local<'_, v8::Value>> = dash.iter().map(|&d| v8::Number::new(scope, d).into()).collect();
        return rv.set(v8::Array::new_with_elements(scope, &items).into());
    }
    let segments = crate::dom::f64_arg(given).to_vec();
    if !segments.iter().all(|v| v.is_finite() && *v >= 0.0) {
        return;
    }
    let dash = if segments.len() % 2 == 1 { [segments.clone(), segments].concat() } else { segments };
    h.state.borrow_mut().dash = dash;
}

// __dom.canvasObject(state, slot) -> the object the state traces in `slot` (0 its fill style's, 1 its stroke style's, 2
// its clip mask) — null for none — or, with `object` given (a third argument), that object set there.
fn canvas_object(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let slot = args.get(1).uint32_value(scope).unwrap_or(0).min(2) as usize;
    if args.length() > 2 {
        let object = v8::Local::<v8::Object>::try_from(args.get(2)).ok();
        return h.set_object(scope, slot, object);
    }
    match h.object(scope, slot) {
        Some(obj) => rv.set(obj.into()),
        None => rv.set_null(),
    }
}

// __dom.canvasFontFace(state) -> `[weight, slant, family, inherits, rem]`: what the bindings answer a text op with — the
// face it is drawn with, which they resolve by the computed font's weight, slant and family (canvas.js `_textInputs`);
// the canvas element's direction, where the state's `direction` inherits it; the root's font size, where a letter or
// word spacing is in `rem`.
fn canvas_font_face(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let (font, inherits, rem) = {
        let s = h.state();
        let rem = |v: &str| v.to_ascii_lowercase().contains("rem");
        (s.font.clone(), DIRECTIONS[s.direction as usize] == "inherit", rem(&s.letter_spacing) || rem(&s.word_spacing))
    };
    let items: [v8::Local<'_, v8::Value>; 5] = [
        v8::Number::new(scope, font.weight).into(),
        v8::Number::new(scope, f64::from(font.slant)).into(),
        string(scope, &font.family),
        v8::Boolean::new(scope, inherits).into(),
        v8::Boolean::new(scope, rem).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
