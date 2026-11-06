// A CanvasImageSource as `drawImage`, `createPattern` and `createImageBitmap` take it (HTML §4.12.5.1.14 "check the
// usability of the image argument", and whether drawing it taints a canvas — its origin-clean flag cleared): an
// ImageBitmap, a `<canvas>` or an OffscreenCanvas, an image element (`<img>`, SVG `<image>`, `<input type=image>`), a
// `<video>` — the bindings classify the object, the engine judges it from what each holds (image_bitmaps.rs,
// canvas_state.rs, offscreen_canvas.rs, image_requests.rs, media.rs).

use crate::canvas::{bitmap_pixels, bytes_mut, bytes_read, bytes_span, convert_buffer, draw, throw_oom, unorm8, Oom, Shape, Space};
use crate::canvas_path::Path;
use crate::canvas_state::CanvasStateHandle;
use crate::dom::{dom, register};
use crate::node_handle::nid_of;

// What the bindings classified the source as.
const BITMAP: u32 = 0;
const CANVAS: u32 = 1;
const OFFSCREEN: u32 = 2;
const IMAGE: u32 = 3;
const VIDEO: u32 = 4;

// The verdict: usable — its pixels to draw, or transparent black (`blank`: a canvas never drawn on, a bitmap of none) —
// bad (nothing drawn: an image not yet decodable or of no size, a video with no frame, a canvas too large for any
// bitmap, which Chrome draws nothing of), or an InvalidStateError for one detached, of no area, or broken.
const GOOD: u32 = 0;
const BAD: u32 = 1;
const DETACHED: u32 = 2;
const NO_AREA: u32 = 3;
const NO_AREA_OFFSCREEN: u32 = 4;
const BROKEN: u32 = 5;

// The most bytes a bitmap may hold (a typed array's, as the bindings make one).
pub(crate) const MAX_IMAGE_BYTES: u64 = 0xFFFF_FFFF;

// A source's verdict, its size (its pixels', a blank one's), whether drawing it taints a canvas, and whether it is blank.
#[derive(Debug, PartialEq)]
struct Judged {
    verdict: u32,
    size: [u32; 2],
    tainted: bool,
    blank: bool,
}
impl Judged {
    fn bad(tainted: bool) -> Judged {
        Judged { verdict: BAD, size: [0, 0], tainted, blank: false }
    }
}
// …a canvas's (an OffscreenCanvas's, `offscreen`) of `size` — an OffscreenCanvas's past any u32 — origin-clean or not,
// drawn into or not.
fn canvas(size: [f64; 2], clean: bool, drawn: bool, offscreen: bool) -> Judged {
    let tainted = !clean;
    if size.contains(&0.0) {
        return Judged { verdict: if offscreen { NO_AREA_OFFSCREEN } else { NO_AREA }, ..Judged::bad(tainted) };
    }
    if size[0] * size[1] * 4.0 > MAX_IMAGE_BYTES as f64 {
        return Judged::bad(tainted);
    }
    Judged { verdict: GOOD, size: size.map(|v| v as u32), tainted, blank: !drawn }
}

// A source's verdict, as the bindings classified it (`kind`): `source` an ImageBitmap's state, a `<canvas>`'s or a media /
// image element's node, an OffscreenCanvas's state; `context` a canvas's context's state, null for one with none.
fn judge(scope: &mut v8::PinScope<'_, '_>, kind: u32, source: v8::Local<'_, v8::Value>, context: v8::Local<'_, v8::Value>) -> Judged {
    let (clean, drawn) = crate::canvas_state::source_facts(scope, context).unwrap_or((true, false));
    match kind {
        BITMAP => match crate::image_bitmaps::source_facts(scope, source) {
            Some((true, _, tainted, _)) => Judged { verdict: DETACHED, ..Judged::bad(tainted) },
            Some((false, size, tainted, pixels)) if (pixels && !size.contains(&0)) || u64::from(size[0]) * u64::from(size[1]) * 4 <= MAX_IMAGE_BYTES => {
                Judged { verdict: GOOD, size, tainted, blank: !pixels || size.contains(&0) }
            }
            Some((false, _, tainted, _)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        CANVAS => {
            let size = nid_of(scope, source).and_then(|id| dom(scope).arena.get(id).map(crate::reflect::canvas_size)).unwrap_or([0, 0]);
            canvas(size.map(f64::from), clean, drawn, false)
        }
        OFFSCREEN => {
            let size = crate::offscreen_canvas::handle(scope, source).map_or([0.0, 0.0], |h| h.size());
            canvas(size, clean, drawn, true)
        }
        IMAGE => match nid_of(scope, source).map(|id| dom(scope).arena.image_source_facts(id)) {
            Some((true, _, tainted, _)) => Judged { verdict: BROKEN, ..Judged::bad(tainted) },
            Some((false, size, tainted, true)) if !size.contains(&0) => Judged { verdict: GOOD, size, tainted, blank: false },
            Some((_, _, tainted, _)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        VIDEO => match nid_of(scope, source).map(|id| dom(scope).arena.video_source_facts(id)) {
            Some((Some(size), tainted)) if !size.contains(&0) => Judged { verdict: GOOD, size, tainted, blank: false },
            Some((_, tainted)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        _ => Judged::bad(false),
    }
}

// What a source judged usable has to read: its pixels (null for a blank one), its Display P3 rendering (null for none) and
// the colour space of the first (canvas_state.rs `COLOR_SPACES`).
const SRGB: u8 = 0;
const DISPLAY_P3: u8 = 2;
fn views_of<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    kind: u32,
    source: v8::Local<'_, v8::Value>,
    context: v8::Local<'_, v8::Value>,
) -> (v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>, u8) {
    let null: v8::Local<'s, v8::Value> = v8::null(scope).into();
    let tagged = |(pixels, wide, display_p3): (v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>, bool)| (pixels, wide, if display_p3 { DISPLAY_P3 } else { SRGB });
    match kind {
        BITMAP => crate::image_bitmaps::source_pixels(scope, source).map(tagged),
        CANVAS | OFFSCREEN => crate::canvas_state::handle(scope, context).map(|c| (c.bitmap(scope), null, c.color_space_code())),
        IMAGE => nid_of(scope, source).and_then(|id| crate::image_requests::source_pixels(scope, id)).map(tagged),
        _ => nid_of(scope, source).and_then(|id| dom(scope).arena.video_frames.get(&id).cloned()).map(|frame| (frame.view(scope), null, SRGB)),
    }
    .unwrap_or((null, null, SRGB))
}

// The pixels a canvas in `target`'s colour space reads of a source judged usable, and their colour space: its own, or, for
// a wide-profile source and a canvas of Display P3's primaries, its Display P3 rendering, whose wide colours survive —
// transparent black, a buffer of their own, for a blank one.
fn pixels_of<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    target: &CanvasStateHandle,
    kind: u32,
    source: v8::Local<'_, v8::Value>,
    context: v8::Local<'_, v8::Value>,
    judged: &Judged,
) -> Result<(v8::Local<'s, v8::Value>, u8), Oom> {
    if judged.blank {
        let [w, h] = judged.size.map(|v| v as usize);
        return Ok((crate::dom::zeroed_clamped_array(scope, w * h * 4).ok_or(Oom)?, SRGB));
    }
    let (pixels, wide, space) = views_of(scope, kind, source, context);
    Ok(if Space::of_code(target.color_space_code()).is_p3() && !wide.is_null() { (wide, DISPLAY_P3) } else { (pixels, space) })
}

// HTML "establish the source and destination rectangles": `given` the drawImage arguments (sx, sy, sw, sh, dx, dy, dw, dh)
// — the source's size the image's, in image pixels, where omitted; the destination's its NATURAL size where that is too,
// "one CSS pixel in the image is treated as one unit" (an image element's bitmap over its source's pixel density: a `2x`
// candidate's half, as Chrome draws a parsed `srcset`; Chrome for a dynamic one, and Firefox for both, draw its pixels).
fn image_rects(given: [Option<f64>; 8], size: [u32; 2], natural: [u32; 2]) -> [f64; 8] {
    let or = |i: usize, default: u32| given[i].unwrap_or(f64::from(default));
    let whole = |v: u32, n: u32| if n > 0 { n } else { v };
    [or(0, 0), or(1, 0), or(2, size[0]), or(3, size[1]), or(4, 0), or(5, 0), or(6, whole(size[0], natural[0])), or(7, whole(size[1], natural[1]))]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "canvasDrawImage", canvas_draw_image, context_id);
    register(scope, ns, "canvasCreatePattern", canvas_create_pattern, context_id);
    register(scope, ns, "imageBitmapOfSource", image_bitmap_of_source, context_id);
    register(scope, ns, "imageBitmapOfBlob", image_bitmap_of_blob, context_id);
    register(scope, ns, "imageBitmapOfImageData", image_bitmap_of_image_data, context_id);
}

// __dom.canvasDrawImage(state, kind, source, contextState, sx, sy, sw, sh, dx, dy, dw, dh) -> 0, or the verdict of a source
// that fails its usability check, the bindings' to throw: `drawImage()`, the source as `judge` takes it, an omitted
// argument undefined. HTML's steps, in their order:
//   "If any of the arguments are infinite or NaN, then return."
//   "Let usability be the result of checking the usability of image." — a failing one thrown, "If usability is bad, then
//   return (without drawing anything)."
//   "Establish the source and destination rectangles" — "If one of the sw or sh arguments is zero, then return."
//   "Paint the region of the image argument" — the destination rectangle through the CTM, under the clip, `globalAlpha`,
//   the operator and the shadow, each covered pixel sampling the source (nearest, or bilinear where smoothing is on and the
//   image is scaled or rotated; a negative dw / dh mirrors). A blank but sized canvas is transparent pixels, which it still
//   DRAWS: a whole-canvas operator clears the destination it does not cover.
//   "If image is not origin-clean, then set the CanvasRenderingContext2D's origin-clean flag to false." — so a draw that
//   returned above does not taint, and one that lands off the canvas does.
fn canvas_draw_image(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(GOOD);
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let given: [Option<f64>; 8] = std::array::from_fn(|i| {
        let v = args.get(i as i32 + 4);
        (!v.is_undefined()).then(|| v8::Local::<v8::Number>::try_from(v).map_or(f64::NAN, |n| n.value()))
    });
    if !given.iter().flatten().all(|v| v.is_finite()) {
        return;
    }
    let kind = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let (source, context) = (args.get(2), args.get(3));
    let judged = judge(scope, kind, source, context);
    if judged.verdict == BAD {
        return;
    }
    if judged.verdict != GOOD {
        return rv.set_uint32(judged.verdict);
    }
    let natural = if kind == IMAGE { nid_of(scope, source).map_or([0, 0], |id| dom(scope).arena.image_natural_size(id)) } else { [0, 0] };
    let [sx, sy, sw, sh, dx, dy, dw, dh] = image_rects(given, judged.size, natural);
    if sw == 0.0 || sh == 0.0 {
        return;
    }
    let (pixels, space) = match pixels_of(scope, h, kind, source, context, &judged) {
        Ok(found) => found,
        Err(Oom) => return throw_oom(scope),
    };
    let (m, smoothing) = {
        let s = h.state();
        (s.m, s.smoothing)
    };
    let [iw, ih] = judged.size.map(f64::from);
    let paint = [6.0, iw, ih, f64::from(space), sx, sy, sw, sh, dx, dy, dw, dh, f64::from(u8::from(smoothing))];
    draw(scope, h, false, &Shape::Rings { rings: Path::rect(m, [dx, dy, dw, dh]).fill_rings(), even_odd: false }, &paint, pixels);
    if judged.tainted {
        h.taint();
    }
}

// Why `canvasCreatePattern` makes none, past the source's verdicts: a repetition that is no keyword's a SyntaxError.
const BAD_REPETITION: u32 = 6;

// A new array of a view's bytes: made first, as the making can collect and a small array's bytes move with it.
fn copy_of<'s>(scope: &mut v8::PinScope<'s, '_>, view: v8::Local<'_, v8::Value>) -> Option<v8::Local<'s, v8::Value>> {
    let made = crate::dom::zeroed_clamped_array(scope, bytes_span(view).map_or(0, |(_, n)| n))?;
    if let (Some(from), Some(to)) = (bytes_read(view, None), bytes_mut(made)) {
        to.copy_from_slice(&from);
    }
    Some(made)
}

// __dom.canvasCreatePattern(paint, wrapper, state, kind, source, contextState, repetition) -> 0, or why it made no pattern:
// `createPattern()`, the source as `judge` takes it, its repetition's code (`canvas_paint.rs` `REPEATS`), -1 for
// none. HTML's steps, in their order: "Let usability be the result of checking the usability of image." — a failing one's
// verdict the bindings' to throw — "If usability is bad, then return null." — the repetition's SyntaxError — then the
// pattern, its tile a copy of the pixels it reads now (canvas_paint.rs `init_pattern`), so that a later draw to a live
// source canvas does not change the pattern: "If image is not origin-clean, then mark pattern as not origin-clean." A
// RangeError for a tile too large to hold.
fn canvas_create_pattern(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(2)) else { return };
    let kind = args.get(3).uint32_value(scope).unwrap_or(u32::MAX);
    let (source, context) = (args.get(4), args.get(5));
    let judged = judge(scope, kind, source, context);
    if judged.verdict != GOOD {
        return rv.set_uint32(judged.verdict);
    }
    let Ok(repetition) = u32::try_from(args.get(6).int32_value(scope).unwrap_or(-1)) else { return rv.set_uint32(BAD_REPETITION) };
    let Ok((pixels, space)) = pixels_of(scope, h, kind, source, context, &judged) else { return throw_oom(scope) };
    let Some(tile) = copy_of(scope, pixels) else { return throw_oom(scope) };
    crate::canvas_paint::init_pattern(scope, args.get(0), args.get(1), tile, judged.size.map(f64::from), repetition, space, judged.tainted);
    rv.set_uint32(GOOD);
}

// ── createImageBitmap (HTML §8.10) ──
// Why it refuses, past the source's verdicts (`BAD` its plain InvalidStateError, the rest usability's): a crop of no area
// is a RangeError; a Blob that does not decode, the InvalidStateError HTML queues a task to reject with, the rest
// returned at once.
const CROP_NO_AREA: u32 = 6;
const UNDECODABLE: u32 = 7;

// What it was asked to do to the pixels: `[crop, sx, sy, sw, sh, resizeWidth, resizeHeight, flipY, colorSpaceConversion
// is "none"]`, `crop` and the flags 0 or 1 and a resize size NaN when the options give none.
struct Steps {
    crop: Option<[f64; 4]>,
    resize: [f64; 2],
    flip: bool,
    unmanaged: bool,
}

impl Steps {
    fn of(g: &[f64]) -> Option<Steps> {
        let &[crop, sx, sy, sw, sh, rw, rh, flip, unmanaged] = g else { return None };
        Some(Steps { crop: (crop != 0.0).then_some([sx, sy, sw, sh]), resize: [rw, rh], flip: flip != 0.0, unmanaged: unmanaged != 0.0 })
    }
    // Its own steps first, whatever the source: "If either sw or sh is given and is 0, then return a promise rejected with
    // a RangeError", "If either options's resizeWidth or options's resizeHeight is present and is 0, then return a
    // promise rejected with an InvalidStateError".
    fn refusal(&self) -> Option<u32> {
        if self.crop.is_some_and(|[_, _, w, h]| w == 0.0 || h == 0.0) {
            return Some(CROP_NO_AREA);
        }
        (self.resize[0] < 1.0 || self.resize[1] < 1.0).then_some(BAD)
    }
    fn transforms(&self) -> bool {
        self.crop.is_some() || self.flip || !self.resize[0].is_nan() || !self.resize[1].is_nan()
    }
    // A Blob's decode shrinks to a resize of both sizes as it goes: with no crop or flip to do first, that is the resize.
    fn fit(&self) -> Option<(u32, u32)> {
        let [w, h] = self.resize;
        (self.crop.is_none() && !self.flip && w >= 1.0 && h >= 1.0).then_some((w as u32, h as u32))
    }
    // The pixels cropped, resized and flipped (`bitmap_pixels`), their size, and whether they are other pixels than the
    // source's — none for a size too large to hold, which browsers too report an InvalidStateError (their max-texture limit).
    fn transformed(&self, px: &[u8], size @ [w, h]: [u32; 2]) -> Option<(Vec<u8>, [u32; 2], bool)> {
        let [sx, sy, sw, sh] = self.crop.unwrap_or([0.0; 4]);
        let geometry = [f64::from(w), f64::from(h), f64::from(u8::from(self.crop.is_some())), sx, sy, sw, sh, self.resize[0], self.resize[1], f64::from(u8::from(self.flip))];
        let (out, ow, oh) = bitmap_pixels(px, geometry)?;
        let made = [ow as u32, oh as u32];
        Some((out, made, self.crop.is_some() || self.flip || made != size))
    }
}

// A bitmap's pixels, as a source has them: an array it keeps, a bitmap never aliasing live pixels; bytes of its own; none,
// a blank source's, this many bytes of transparent black.
enum Source<'s> {
    View(v8::Local<'s, v8::Value>),
    Owned(Vec<u8>),
    Blank(usize),
}

// What an op hands back: why it refused, or `[pixels, width, height, pixelsP3 | null, displayP3, tainted]`, what the
// bindings make the ImageBitmap of. `colorSpaceConversion: "none"` means the source's bytes are treated as unmanaged (sRGB,
// no conversion downstream); otherwise a later draw converts from the colour space kept. The Display P3 rendering of a
// wide-profile source is carried only by a bitmap of the same pixels: a crop, a resize or a flip would have to re-derive it.
struct Pixels<'s> {
    source: Source<'s>,
    size: [u32; 2],
    wide: v8::Local<'s, v8::Value>,
    display_p3: bool,
    tainted: bool,
}
fn hand_back<'s>(scope: &mut v8::PinScope<'s, '_>, steps: &Steps, p: Pixels<'s>, rv: &mut v8::ReturnValue<'_, v8::Value>) {
    let (made, [w, h], other) = if steps.transforms() {
        let done = match &p.source {
            Source::View(view) => bytes_read(*view, None).and_then(|px| steps.transformed(&px, p.size)),
            Source::Owned(px) => steps.transformed(px, p.size),
            Source::Blank(n) => steps.transformed(&vec![0; *n], p.size),
        };
        let Some((out, size, other)) = done else { return rv.set_uint32(BAD) };
        (Some(crate::dom::u8_clamped_array(scope, out)), size, other)
    } else {
        let made = match p.source {
            Source::View(view) => copy_of(scope, view),
            Source::Owned(px) => Some(crate::dom::u8_clamped_array(scope, px)),
            Source::Blank(n) => crate::dom::zeroed_clamped_array(scope, n),
        };
        (made, p.size, false)
    };
    let Some(made) = made.filter(|m| !m.is_undefined()) else { return rv.set_uint32(BAD) };
    let wide = if other || steps.unmanaged { v8::null(scope).into() } else { p.wide };
    let items = [
        made,
        v8::Integer::new_from_unsigned(scope, w).into(),
        v8::Integer::new_from_unsigned(scope, h).into(),
        wide,
        v8::Boolean::new(scope, p.display_p3 && !steps.unmanaged).into(),
        v8::Boolean::new(scope, p.tainted).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.imageBitmapOfSource(steps, kind, source, contextState) -> a bitmap of an image, a video, a canvas or an ImageBitmap
// (`judge`): its verdict where that is not good — bad as much as failing — else its pixels, a canvas's its bitmap's snapshot,
// transparent black where nothing was drawn. A flip is of the image as stored: "output must be flipped vertically,
// disregarding any image orientation metadata of the source (such as EXIF metadata)".
fn image_bitmap_of_source(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(steps) = Steps::of(&crate::dom::f64_arg(args.get(0))) else { return rv.set_uint32(BAD) };
    if let Some(refusal) = steps.refusal() {
        return rv.set_uint32(refusal);
    }
    let kind = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let (source, context) = (args.get(2), args.get(3));
    let judged = judge(scope, kind, source, context);
    if judged.verdict != GOOD {
        return rv.set_uint32(judged.verdict);
    }
    let (pixels, wide, space) = views_of(scope, kind, source, context);
    // (…an ImageBitmap keeps no linear values: a linear canvas's encoded)
    let (space, encoded) = (Space::of_code(space), Space::of_code(space).encoded());
    let display_p3 = encoded.is_p3();
    let null = v8::null(scope).into();
    if judged.blank {
        let [w, h] = judged.size.map(|v| v as usize);
        let p = Pixels { source: Source::Blank(w * h * 4), size: judged.size, wide: null, display_p3, tainted: judged.tainted };
        return hand_back(scope, &steps, p, &mut rv);
    }
    if bytes_span(pixels).is_none() {
        return rv.set_uint32(BAD);
    }
    let orientation = if kind == IMAGE && steps.flip { nid_of(scope, source).map_or(0, |id| dom(scope).arena.image_orientation(id)) } else { 0 };
    let p = if space != encoded {
        let mut px = bytes_read(pixels, None).unwrap_or_default().into_owned();
        convert_buffer(space, encoded, &mut px);
        Pixels { source: Source::Owned(px), size: judged.size, wide, display_p3, tainted: judged.tainted }
    } else if orientation > 1 {
        let px = bytes_read(pixels, None).unwrap_or_default();
        let Some((px, size)) = crate::image_decode::unoriented(&px, judged.size, orientation) else { return rv.set_uint32(BAD) };
        Pixels { source: Source::Owned(px), size, wide: null, display_p3, tainted: judged.tainted }
    } else {
        Pixels { source: Source::View(pixels), size: judged.size, wide, display_p3, tainted: judged.tainted }
    };
    hand_back(scope, &steps, p, &mut rv);
}

// __dom.imageBitmapOfBlob(steps, bytes) -> a bitmap of a Blob's bytes decoded: `UNDECODABLE` for none or an undecodable one.
fn image_bitmap_of_blob(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(steps) = Steps::of(&crate::dom::f64_arg(args.get(0))) else { return rv.set_uint32(BAD) };
    if let Some(refusal) = steps.refusal() {
        return rv.set_uint32(refusal);
    }
    let Some(bytes) = bytes_read(args.get(1), None) else { return rv.set_uint32(UNDECODABLE) };
    let decoded = std::panic::catch_unwind(|| crate::image_decode::decode(&bytes, steps.fit()));
    let Ok(crate::image_decode::Decoded::Bitmap(b)) = decoded else { return rv.set_uint32(UNDECODABLE) };
    if b.rgba.is_empty() {
        return rv.set_uint32(UNDECODABLE);
    }
    let size = [b.width, b.height];
    let null: v8::Local<'_, v8::Value> = v8::null(scope).into();
    let p = if steps.flip && b.orientation > 1 {
        let Some((px, size)) = crate::image_decode::unoriented(&b.rgba, size, b.orientation) else { return rv.set_uint32(BAD) };
        Pixels { source: Source::Owned(px), size, wide: null, display_p3: b.display_p3, tainted: false }
    } else {
        let wide = b.rgba_p3.map_or(null, |p| crate::dom::u8_clamped_array(scope, p));
        Pixels { source: Source::Owned(b.rgba), size, wide, display_p3: b.display_p3, tainted: false }
    };
    hand_back(scope, &steps, p, &mut rv);
}

// __dom.imageBitmapOfImageData(steps, data, float16, colorSpace, width, height) -> a bitmap of an ImageData's pixels — RGBA
// bytes in a colour space a canvas holds, a linear one's converted to its encoded counterpart — `BAD` for one whose
// array's buffer is detached: "If IsDetachedBuffer(buffer) is true, then return a promise rejected with an
// "InvalidStateError" DOMException."
fn image_bitmap_of_image_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(steps) = Steps::of(&crate::dom::f64_arg(args.get(0))) else { return rv.set_uint32(BAD) };
    if let Some(refusal) = steps.refusal() {
        return rv.set_uint32(refusal);
    }
    let Some(px) = bytes_read(args.get(1), None) else { return rv.set_uint32(BAD) };
    let mut own = args.get(2).is_true().then(|| unorm8(&px));
    let space = Space::of_name(&args.get(3).to_rust_string_lossy(scope));
    let encoded = space.encoded();
    if encoded != space {
        convert_buffer(space, encoded, own.get_or_insert_with(|| px.to_vec()));
    }
    let size = [4, 5].map(|i| args.get(i).uint32_value(scope).unwrap_or(0));
    let wide = v8::null(scope).into();
    let view = v8::Local::new(scope, args.get(1));
    let source = own.map_or(Source::View(view), Source::Owned);
    let p = Pixels { source, size, wide, display_p3: encoded.is_p3(), tainted: false };
    hand_back(scope, &steps, p, &mut rv);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_canvas_is_judged_by_its_area_and_its_bitmap() {
        assert_eq!(canvas([0.0, 5.0], true, false, false).verdict, NO_AREA);
        assert_eq!(canvas([5.0, 0.0], false, false, true), Judged { verdict: NO_AREA_OFFSCREEN, size: [0, 0], tainted: true, blank: false });
        assert_eq!(canvas([100_000.0, 100_000.0], true, true, false).verdict, BAD);
        // (…an OffscreenCanvas past any u32 too large for a bitmap, not of no area)
        assert_eq!(canvas([4_294_967_296.0, 1.0], true, false, true).verdict, BAD);
        assert_eq!(canvas([3.0, 4.0], true, false, false), Judged { verdict: GOOD, size: [3, 4], tainted: false, blank: true });
        assert_eq!(canvas([3.0, 4.0], false, true, true), Judged { verdict: GOOD, size: [3, 4], tainted: true, blank: false });
    }

    // The rectangles each overload leaves: the source's size the image's, the destination's its natural size where only
    // that is omitted too (a `2x` image's half), the arguments given as they are.
    #[test]
    fn the_rectangles_default_as_html_says() {
        let n = None;
        let v = Some;
        assert_eq!(image_rects([v(0.0), v(0.0), n, n, v(5.0), v(6.0), n, n], [100, 50], [50, 25]), [0.0, 0.0, 100.0, 50.0, 5.0, 6.0, 50.0, 25.0]);
        // (…no natural size to the source: its pixels')
        assert_eq!(image_rects([v(0.0), v(0.0), n, n, v(5.0), v(6.0), n, n], [100, 50], [0, 0]), [0.0, 0.0, 100.0, 50.0, 5.0, 6.0, 100.0, 50.0]);
        assert_eq!(image_rects([v(0.0), v(0.0), n, n, v(5.0), v(6.0), v(7.0), v(8.0)], [100, 50], [50, 25]), [0.0, 0.0, 100.0, 50.0, 5.0, 6.0, 7.0, 8.0]);
        let all = [v(1.0), v(2.0), v(3.0), v(4.0), v(5.0), v(6.0), v(7.0), v(8.0)];
        assert_eq!(image_rects(all, [100, 50], [50, 25]), [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
    }

    // Its own refusals first (a crop of no area a RangeError's, a resize of none an InvalidStateError's), and what it does
    // to the pixels: nothing asked, the source's own moved or copied; a resize to the size they have no other pixels.
    #[test]
    fn create_image_bitmap_steps() {
        let of = |g: &[f64]| Steps::of(g).unwrap();
        let none = f64::NAN;
        assert!(Steps::of(&[0.0; 3]).is_none());
        assert_eq!(of(&[1.0, 0.0, 0.0, 0.0, 1.0, none, none, 0.0, 0.0]).refusal(), Some(CROP_NO_AREA));
        assert_eq!(of(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0, none, 0.0, 0.0]).refusal(), Some(CROP_NO_AREA));
        assert_eq!(of(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, none, 0.0, 0.0]).refusal(), Some(BAD));
        assert_eq!(of(&[0.0, 0.0, 0.0, 0.0, 0.0, none, 0.0, 0.0, 0.0]).refusal(), Some(BAD));
        assert_eq!(of(&[1.0, 0.0, 0.0, -1.0, -1.0, 1.0, 1.0, 0.0, 0.0]).refusal(), None);

        let px = [1u8, 2, 3, 4];
        let plain = of(&[0.0, 0.0, 0.0, 0.0, 0.0, none, none, 0.0, 0.0]);
        assert!(!plain.transforms());
        assert_eq!(plain.fit(), None);
        let same_size = of(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
        assert_eq!(same_size.fit(), Some((1, 1)));
        assert_eq!(same_size.transformed(&px, [1, 1]), Some((px.to_vec(), [1, 1], false)));
        let flipped = of(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0]);
        assert_eq!(flipped.fit(), None);
        assert_eq!(flipped.transformed(&px, [1, 1]), Some((px.to_vec(), [1, 1], true)));
        // (…a size too large to hold)
        assert_eq!(of(&[0.0, 0.0, 0.0, 0.0, 0.0, 65536.0, 65536.0, 0.0, 0.0]).transformed(&px, [1, 1]), None);
    }
}
