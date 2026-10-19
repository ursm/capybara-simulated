// An image element's current request (HTML §4.8.4.3 "images processing model") — an `<img>`'s, an SVG `<image>`'s, an
// `<input type=image>`'s — the engine's: whether it is complete and whether it is broken, the URL it was made for, the
// decoded image's size, whether it taints a canvas it is drawn into, the EXIF turn the decode applied, and which load is
// the current one — a later one supersedes what an earlier one has in flight or queued — with the (URL, CORS mode) it was
// made for, which a relevant mutation that changes neither does not restart — and the decoded bitmap, which a canvas
// draws and the painter paints (`imageBitmap`). The bindings fetch the resource (through a service worker or the host)
// and fire the events (dom-nodes.js `_loadImageResource`). Kept per element in the arena (`RealmArena::images`), from
// its first load.

use crate::dom::{NodeId, RealmArena};

// (…before its first load, none complete: a load the realm cannot make, or of a scheme it cannot read, leaves it so)
#[derive(Clone, Default)]
pub(crate) struct ImageRequest {
    // None for no request made, or none since one with no source (unavailable: complete, not broken).
    url: Option<String>,
    complete: bool,
    broken: bool,
    size: [u32; 2],
    tainted: bool,
    orientation: u8,
    // The current pixel density of its source (a `2x` candidate's 2; 0, unset, as 1): what its natural size is divided
    // by (HTML: the density-corrected natural width and height).
    density: f64,
    load: u32,
    // (…the key a hash: a `data:` URL is the whole image)
    key: Option<u64>,
    // Its decoded image's pixels, none where it has none (unavailable, pending, broken, no area).
    bitmap: Option<Bitmap>,
}

// A decoded image's pixels: its RGBA bytes in sRGB — and, for a wide-gamut source (Adobe RGB, CMYK), in Display P3 as
// well, which a P3 canvas draws — and the colour space drawImage converts it from.
#[derive(Clone)]
struct Bitmap {
    srgb: Pixels,
    p3: Option<Pixels>,
    display_p3: bool,
}
// …each the byte view it was given (the host's transfer, a decode's), held: the same array handed to every draw, never
// copied for one, and counted by the collector as any array is. (…and a video's decoded frame: media.rs)
#[derive(Clone)]
pub(crate) struct Pixels(v8::Global<v8::Object>);

impl Pixels {
    pub(crate) fn of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<Pixels> {
        let view = v8::Local::<v8::ArrayBufferView>::try_from(value).ok()?;
        Some(Pixels(v8::Global::new(scope, v8::Local::<v8::Object>::from(view))))
    }
    pub(crate) fn view<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
        v8::Local::new(scope, &self.0).into()
    }
}

// What a load's result is.
const RESULT_BROKEN: u32 = 0;
const RESULT_IMAGE: u32 = 1;
// (…an image with no pixels to it — no area, or data corrupt past the header that gave its size: the request succeeded)
const RESULT_NO_PIXELS: u32 = 2;

impl RealmArena {
    fn image(&self, id: NodeId) -> Option<&ImageRequest> {
        self.images.get(&id)
    }
    fn image_mut(&mut self, id: NodeId) -> &mut ImageRequest {
        self.images.entry(id).or_default()
    }
    // Whether `id`'s image is coming: a request for a source made, and not complete — what keeps a sized `<img>` replaced
    // while it loads (walk.rs `img_alt_text`).
    pub(crate) fn image_pending(&self, id: NodeId) -> bool {
        self.image(id).is_some_and(|r| r.url.is_some() && !r.complete)
    }
    // `id`'s decoded bitmap becomes `bitmap`.
    fn set_image_bitmap(&mut self, id: NodeId, bitmap: Option<Bitmap>) {
        self.images.entry(id).or_default().bitmap = bitmap;
    }
    // …and the pixel density its current request's source has (1 for none).
    pub(crate) fn image_density(&self, id: NodeId) -> f64 {
        self.image(id).map(|r| r.density).filter(|&d| d > 0.0 && d.is_finite()).unwrap_or(1.0)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "imageLoadBegin", load_begin, context_id);
    crate::dom::register(scope, ns, "imageLoadClear", load_clear, context_id);
    crate::dom::register(scope, ns, "imagePending", pending, context_id);
    crate::dom::register(scope, ns, "imageApply", apply, context_id);
    crate::dom::register(scope, ns, "imageInfo", info, context_id);
    crate::dom::register(scope, ns, "imageUrl", url, context_id);
    crate::dom::register(scope, ns, "imageLoad", current_load, context_id);
    crate::dom::register(scope, ns, "imageBitmap", bitmap_op, context_id);
}

fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    crate::node_handle::nid_of(scope, value)
}

// __dom.imageLoadBegin(img, url, crossorigin, density) -> the new load's number, or 0 where `url`, the CORS mode
// (`crossorigin`, null for none) and the pixel density (1 where not given) are the ones the current load was made for (a
// relevant mutation that changes none restarts nothing). The request's URL is `url` from then on: what `currentSrc`
// reads.
fn load_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use std::hash::{Hash, Hasher};
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(0) };
    let url = args.get(1).to_rust_string_lossy(scope);
    let mode = args.get(2);
    let mode = (!mode.is_null_or_undefined()).then(|| mode.to_rust_string_lossy(scope));
    let density = args.get(3).number_value(scope).filter(|&d| d > 0.0 && d.is_finite()).unwrap_or(1.0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&url, &mode, density.to_bits()).hash(&mut hasher);
    let key = hasher.finish();
    let r = crate::dom::dom(scope).arena.image_mut(id);
    if r.key == Some(key) {
        return rv.set_uint32(0);
    }
    r.key = Some(key);
    r.url = Some(url);
    r.density = density;
    r.load += 1;
    rv.set_uint32(r.load);
}
// __dom.imageLoadClear(img): no source — no request: unavailable, complete, not broken, no taint, no size; a load in
// flight superseded, and a later source of any URL a new load.
fn load_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    arena.set_image_bitmap(id, None);
    let r = arena.image_mut(id);
    *r = ImageRequest { complete: true, load: r.load + 1, ..ImageRequest::default() };
}
// __dom.imagePending(img): the current request pending — not complete, its image data discarded until the response
// comes.
fn pending(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    arena.set_image_bitmap(id, None);
    let r = arena.image_mut(id);
    r.complete = false;
    r.broken = false;
    r.size = [0, 0];
}
// __dom.imageApply(img, load, result, width, height, orientation, tainted, pixels, pixelsP3, displayP3) -> whether the
// result applies: load `load`'s (`RESULT_IMAGE` …), none where a later load superseded it. Complete either way; broken
// for `RESULT_BROKEN`; an image's decoded pixels (`pixels`, and `pixelsP3` for a wide-gamut source, Uint8ClampedArrays;
// `displayP3` the space they are in) its bitmap.
fn apply(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    let number = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).uint32_value(scope).unwrap_or(0);
    let (load, result, width, height, orientation) = (number(scope, 1), number(scope, 2), number(scope, 3), number(scope, 4), number(scope, 5));
    let tainted = args.get(6).is_true();
    let bitmap = Pixels::of(scope, args.get(7))
        .filter(|_| result == RESULT_IMAGE)
        .map(|srgb| Bitmap { srgb, p3: Pixels::of(scope, args.get(8)), display_p3: args.get(9).is_true() });
    let arena = &mut crate::dom::dom(scope).arena;
    if load != arena.image_mut(id).load {
        return rv.set_bool(false);
    }
    arena.set_image_bitmap(id, bitmap);
    let r = arena.image_mut(id);
    r.complete = true;
    r.broken = result == RESULT_BROKEN;
    let image = matches!(result, RESULT_IMAGE | RESULT_NO_PIXELS);
    r.size = if image { [width, height] } else { [0, 0] };
    r.orientation = if image { orientation as u8 } else { 0 };
    r.tainted = image && tainted;
    rv.set_bool(true);
}
// __dom.imageInfo(img) -> [complete, broken, width, height, tainted, orientation, density]: the current request, as the
// element's members and a canvas read it — its decoded bitmap's size, and its source's pixel density, which the natural
// size is that size divided by.
fn info(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let (complete, broken, size, tainted, orientation) = match crate::dom::dom(scope).arena.image(id) {
        Some(r) => (r.complete, r.broken, r.size, r.tainted, r.orientation),
        None => (false, false, [0, 0], false, 0),
    };
    let density = crate::dom::dom(scope).arena.image_density(id);
    let items = [
        v8::Boolean::new(scope, complete).into(),
        v8::Boolean::new(scope, broken).into(),
        v8::Integer::new_from_unsigned(scope, size[0]).into(),
        v8::Integer::new_from_unsigned(scope, size[1]).into(),
        v8::Boolean::new(scope, tainted).into(),
        v8::Integer::new_from_unsigned(scope, u32::from(orientation)).into(),
        v8::Number::new(scope, density).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.imageBitmap(img) -> [pixels, pixelsP3 | null, displayP3] — views on the current request's decoded bitmap — or
// null where it has none.
fn bitmap_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let Some(b) = crate::dom::dom(scope).arena.image(id).and_then(|r| r.bitmap.clone()) else { return rv.set_null() };
    let items = [
        b.srgb.view(scope),
        match &b.p3 {
            Some(p) => p.view(scope),
            None => v8::null(scope).into(),
        },
        v8::Boolean::new(scope, b.display_p3).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.imageUrl(img) -> the current request's URL, null for none: its own op, for a `data:` URL is the whole image.
fn url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let Some(url) = crate::dom::dom(scope).arena.image(id).and_then(|r| r.url.clone()) else { return rv.set_null() };
    match v8::String::new(scope, &url) {
        Some(s) => rv.set(s.into()),
        None => rv.set_null(),
    }
}
// __dom.imageLoad(img) -> the current load's number (0 before any).
fn current_load(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(0) };
    rv.set_uint32(crate::dom::dom(scope).arena.image(id).map_or(0, |r| r.load));
}
