// A CanvasImageSource as `drawImage`, `createPattern` and `createImageBitmap` take it (HTML §4.12.5.1.14 "check the
// usability of the image argument", and whether drawing it taints a canvas — its origin-clean flag cleared): an
// ImageBitmap, a `<canvas>` or an OffscreenCanvas, an image element (`<img>`, SVG `<image>`, `<input type=image>`), a
// `<video>` — the bindings classify the object, the engine judges it from what each holds (image_bitmaps.rs,
// canvas_state.rs, offscreen_canvas.rs, image_requests.rs, media.rs).

use crate::dom::{realm, realm_id, register};
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
const MAX_IMAGE_BYTES: u64 = 0xFFFF_FFFF;

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
// …a canvas's (an OffscreenCanvas's, `offscreen`) of `size`, origin-clean or not, drawn into or not.
fn canvas(size: [u32; 2], clean: bool, drawn: bool, offscreen: bool) -> Judged {
    let tainted = !clean;
    if size.contains(&0) {
        return Judged { verdict: if offscreen { NO_AREA_OFFSCREEN } else { NO_AREA }, ..Judged::bad(tainted) };
    }
    if u64::from(size[0]) * u64::from(size[1]) * 4 > MAX_IMAGE_BYTES {
        return Judged::bad(tainted);
    }
    Judged { verdict: GOOD, size, tainted, blank: !drawn }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "canvasImageSource", canvas_image_source_op, context_id);
}

// __dom.canvasImageSource(kind, source, contextState) -> [verdict, width, height, tainted, blank] of a source the bindings
// classified as `kind`: `source` an ImageBitmap's state, a `<canvas>`'s or a media / image element's node, an
// OffscreenCanvas's state; `contextState` a canvas's context's, null for one with none.
fn canvas_image_source_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let context = crate::canvas_state::source_facts(scope, args.get(2));
    let (clean, drawn) = context.unwrap_or((true, false));
    let cid = realm_id(scope, &args);
    let judged = match kind {
        BITMAP => match crate::image_bitmaps::source_facts(scope, args.get(1)) {
            Some((true, _, tainted, _)) => Judged { verdict: DETACHED, ..Judged::bad(tainted) },
            Some((false, size, tainted, pixels)) if (pixels && !size.contains(&0)) || u64::from(size[0]) * u64::from(size[1]) * 4 <= MAX_IMAGE_BYTES => {
                Judged { verdict: GOOD, size, tainted, blank: !pixels || size.contains(&0) }
            }
            Some((false, _, tainted, _)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        CANVAS => {
            let size = nid_of(scope, args.get(1)).and_then(|id| realm(scope, cid).get(id).map(crate::reflect::canvas_size)).unwrap_or([0, 0]);
            canvas(size, clean, drawn, false)
        }
        OFFSCREEN => {
            let size = crate::offscreen_canvas::handle(scope, args.get(1)).map_or([0, 0], |h| h.size());
            canvas(size, clean, drawn, true)
        }
        IMAGE => match nid_of(scope, args.get(1)).map(|id| realm(scope, cid).image_source_facts(id)) {
            Some((true, _, tainted, _)) => Judged { verdict: BROKEN, ..Judged::bad(tainted) },
            Some((false, size, tainted, true)) if !size.contains(&0) => Judged { verdict: GOOD, size, tainted, blank: false },
            Some((_, _, tainted, _)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        VIDEO => match nid_of(scope, args.get(1)).map(|id| realm(scope, cid).video_source_facts(id)) {
            Some((Some(size), tainted)) if !size.contains(&0) => Judged { verdict: GOOD, size, tainted, blank: false },
            Some((_, tainted)) => Judged::bad(tainted),
            None => Judged::bad(false),
        },
        _ => Judged::bad(false),
    };
    let items = [
        v8::Integer::new_from_unsigned(scope, judged.verdict).into(),
        v8::Integer::new_from_unsigned(scope, judged.size[0]).into(),
        v8::Integer::new_from_unsigned(scope, judged.size[1]).into(),
        v8::Boolean::new(scope, judged.tainted).into(),
        v8::Boolean::new(scope, judged.blank).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_canvas_is_judged_by_its_area_and_its_bitmap() {
        assert_eq!(canvas([0, 5], true, false, false).verdict, NO_AREA);
        assert_eq!(canvas([5, 0], false, false, true), Judged { verdict: NO_AREA_OFFSCREEN, size: [0, 0], tainted: true, blank: false });
        assert_eq!(canvas([100_000, 100_000], true, true, false).verdict, BAD);
        assert_eq!(canvas([3, 4], true, false, false), Judged { verdict: GOOD, size: [3, 4], tainted: false, blank: true });
        assert_eq!(canvas([3, 4], false, true, true), Judged { verdict: GOOD, size: [3, 4], tainted: true, blank: false });
    }
}
