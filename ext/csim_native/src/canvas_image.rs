// A CanvasImageSource as `drawImage`, `createPattern` and `createImageBitmap` take it (HTML §4.12.5.1.14 "check the
// usability of the image argument", and whether drawing it taints a canvas — its origin-clean flag cleared): an
// ImageBitmap, a `<canvas>` or an OffscreenCanvas, an image element (`<img>`, SVG `<image>`, `<input type=image>`), a
// `<video>` — the bindings classify the object, the engine judges it from what each holds (image_bitmaps.rs,
// canvas_state.rs, offscreen_canvas.rs, image_requests.rs, media.rs).

use crate::canvas::{bytes_read, draw, throw_oom, zeroed_bytes, Oom, Shape};
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

// The pixels a canvas in `target`'s colour space reads of a source judged usable, and whether they are Display P3 values:
// its own, or, for a wide-profile source and a Display P3 canvas, its Display P3 rendering, whose wide colours survive —
// transparent black, a buffer of their own, for a blank one.
fn pixels_of<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    target: &CanvasStateHandle,
    kind: u32,
    source: v8::Local<'_, v8::Value>,
    context: v8::Local<'_, v8::Value>,
    judged: &Judged,
) -> Result<(v8::Local<'s, v8::Value>, bool), Oom> {
    if judged.blank {
        let [w, h] = judged.size.map(|v| v as usize);
        return Ok((crate::dom::u8_clamped_array(scope, zeroed_bytes(w * h * 4)?), false));
    }
    let null: v8::Local<'s, v8::Value> = v8::null(scope).into();
    let (pixels, wide, display_p3) = match kind {
        BITMAP => crate::image_bitmaps::source_pixels(scope, source),
        CANVAS | OFFSCREEN => crate::canvas_state::handle(scope, context).map(|c| (c.bitmap(scope), null, c.display_p3())),
        IMAGE => nid_of(scope, source).and_then(|id| crate::image_requests::source_pixels(scope, id)),
        _ => nid_of(scope, source).and_then(|id| dom(scope).arena.video_frames.get(&id).cloned()).map(|frame| (frame.view(scope), null, false)),
    }
    .unwrap_or((null, null, false));
    Ok(if target.display_p3() && !wide.is_null() { (wide, true) } else { (pixels, display_p3) })
}

// HTML "establish the source and destination rectangles": `given` the drawImage arguments (sx, sy, sw, sh, dx, dy, dw, dh)
// — the source's size the image's, in image pixels, where omitted; the destination's its NATURAL size where that is too,
// "one CSS pixel in the image [...] treated as one unit" (an image element's bitmap over its source's pixel density: a `2x`
// candidate's half; Chrome and Firefox).
fn image_rects(given: [Option<f64>; 8], size: [u32; 2], natural: [u32; 2]) -> [f64; 8] {
    let or = |i: usize, default: u32| given[i].unwrap_or(f64::from(default));
    let whole = |v: u32, n: u32| if n > 0 { n } else { v };
    [or(0, 0), or(1, 0), or(2, size[0]), or(3, size[1]), or(4, 0), or(5, 0), or(6, whole(size[0], natural[0])), or(7, whole(size[1], natural[1]))]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "canvasImageSource", canvas_image_source_op, context_id);
    register(scope, ns, "canvasDrawImage", canvas_draw_image, context_id);
    register(scope, ns, "canvasPatternTile", canvas_pattern_tile, context_id);
}

// __dom.canvasImageSource(kind, source, contextState) -> [verdict, width, height, tainted, blank] of a source (`judge`).
fn canvas_image_source_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let judged = judge(scope, kind, args.get(1), args.get(2));
    let items = [
        v8::Integer::new_from_unsigned(scope, judged.verdict).into(),
        v8::Integer::new_from_unsigned(scope, judged.size[0]).into(),
        v8::Integer::new_from_unsigned(scope, judged.size[1]).into(),
        v8::Boolean::new(scope, judged.tainted).into(),
        v8::Boolean::new(scope, judged.blank).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.canvasDrawImage(state, kind, source, contextState, sx, sy, sw, sh, dx, dy, dw, dh) -> 0, or the verdict of a source
// that fails its usability check, the bindings' to throw: `drawImage()`, the source as `canvasImageSource` takes it, an
// omitted argument undefined. HTML's steps, in their order:
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
    let (pixels, p3) = match pixels_of(scope, h, kind, source, context, &judged) {
        Ok(found) => found,
        Err(Oom) => return throw_oom(scope),
    };
    let (m, smoothing) = {
        let s = h.state();
        (s.m, s.smoothing)
    };
    let [iw, ih] = judged.size.map(f64::from);
    let paint = [6.0, iw, ih, f64::from(u8::from(p3)), sx, sy, sw, sh, dx, dy, dw, dh, f64::from(u8::from(smoothing))];
    draw(scope, h, false, &Shape::Rings { rings: Path::rect(m, [dx, dy, dw, dh]).fill_rings(), even_odd: false }, &paint, pixels);
    if judged.tainted {
        h.taint();
    }
}

// __dom.canvasPatternTile(paint, wrapper, state, kind, source, contextState, repetition): a pattern made of a source judged
// usable (`canvasImageSource`) for the context `state`, its tile a copy of the pixels it reads now (`canvasPatternInit`): a
// later draw to a live source canvas does not change the pattern. A RangeError for a tile too large to hold.
fn canvas_pattern_tile(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(2)) else { return };
    let kind = args.get(3).uint32_value(scope).unwrap_or(u32::MAX);
    let (source, context) = (args.get(4), args.get(5));
    let judged = judge(scope, kind, source, context);
    let Ok((pixels, p3)) = pixels_of(scope, h, kind, source, context, &judged) else { return throw_oom(scope) };
    let tile = bytes_read(pixels, None).unwrap_or_default().into_owned();
    let tile = crate::dom::u8_clamped_array(scope, tile);
    let repetition = args.get(6).uint32_value(scope).unwrap_or(0);
    crate::canvas_paint::init_pattern(scope, args.get(0), args.get(1), tile, judged.size.map(f64::from), repetition, p3);
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
}
