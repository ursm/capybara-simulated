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

// An image's fetch the host makes on a thread of its own (dom-nodes.js `_finishImageLoadFromNetwork`): the realm that
// began it — whose document's load it delays, and which takes its result, wherever the element went meanwhile — the
// element — held, as an element whose image is being fetched is kept from being collected — the load it is for, its URL
// and when it began — what its Resource Timing entry reports — until the host hands the result back (`imageFetchTake`).
pub(crate) struct HostFetch {
    realm: i32,
    node: NodeId,
    element: v8::Global<v8::Value>,
    load: u32,
    src: String,
    start: f64,
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
    // …realm `realm`'s fetches and held-back results forgotten with its nodes: a node id a later page reuses is no image
    // of theirs, and its realm's document delays nothing any more.
    pub(crate) fn forget_image_fetches_of(&mut self, realm: i32) {
        self.image_fetches.retain(|_, f| f.realm != realm);
        self.image_arrivals.retain(|a| a.0 != realm);
    }
    // Whether load `load` is `id`'s current one (no later one superseded — aborted — it).
    fn image_load_current(&self, id: NodeId, load: u32) -> bool {
        self.image(id).is_some_and(|r| r.load == load)
    }
    // Whether realm `realm`'s images delay its document's load event (HTML: an image's fetch in progress does): a
    // current load the host is fetching — or, `arrivals_only`, none of those, the host counting them itself — or whose
    // result its server's delay holds back. A load a later one superseded delays nothing: aborted, it is in progress no
    // more.
    pub(crate) fn images_delay_load(&self, realm: i32, arrivals_only: bool) -> bool {
        let current = |node: NodeId, load: u32| self.get(node).is_some() && self.image_load_current(node, load);
        (!arrivals_only && self.image_fetches.values().any(|f| f.realm == realm && current(f.node, f.load)))
            || self.image_arrivals.iter().any(|&(r, node, load)| r == realm && current(node, load))
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
    crate::dom::register(scope, ns, "imageFetchTake", fetch_take, context_id);
    crate::dom::register(scope, ns, "imageFetchRealm", fetch_realm, context_id);
    crate::dom::register(scope, ns, "imageArrival", arrival, context_id);
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
    arena.set_natural_size(id, None);
}
// __dom.imagePending(img): the current request pending — not complete, its image data and natural size discarded until
// the response comes.
fn pending(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    crate::dom::dom(scope).arena.set_image_pending(id);
}
impl RealmArena {
    // The element `id`'s request pending: its image data discarded until the response arrives (HTML "update the image
    // data": unavailable, not complete, not broken).
    pub(crate) fn set_image_pending(&mut self, id: NodeId) {
        self.set_image_bitmap(id, None);
        let r = self.image_mut(id);
        r.complete = false;
        r.broken = false;
        r.size = [0, 0];
        self.set_natural_size(id, None);
    }
    // …its current load's number, 0 for none.
    pub(crate) fn image_load_of(&self, id: NodeId) -> u32 {
        self.image(id).map_or(0, |r| r.load)
    }
}
// The element `id`'s load `load` applied with what its response decoded to — an image (`decoded`, its pixels), one of no
// pixels, or none (broken) — `tainted` its response's CORS-cross-origin, and its natural size set: whether it was the
// current load, which a later one superseded otherwise.
pub(crate) fn apply_decoded(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, decoded: Option<crate::image_decode::Bitmap>, tainted: bool) -> bool {
    if crate::dom::dom(scope).arena.image_load_of(id) != load {
        return false;
    }
    let result = match &decoded {
        None => RESULT_BROKEN,
        Some(b) if b.rgba.is_empty() => RESULT_NO_PIXELS,
        Some(_) => RESULT_IMAGE,
    };
    let (size, orientation, natural) = decoded.as_ref().map_or(([0, 0], 0, None), |b| ([b.width, b.height], b.orientation, Some(b.natural)));
    let bitmap = decoded.filter(|_| result == RESULT_IMAGE).and_then(|b| {
        let srgb = crate::dom::u8_clamped_array(scope, b.rgba);
        let p3 = b.rgba_p3.map(|p| crate::dom::u8_clamped_array(scope, p));
        Some(Bitmap { srgb: Pixels::of(scope, srgb)?, p3: p3.and_then(|p| Pixels::of(scope, p)), display_p3: b.display_p3 })
    });
    let arena = &mut crate::dom::dom(scope).arena;
    arena.set_image_bitmap(id, bitmap);
    let r = arena.image_mut(id);
    r.complete = true;
    r.broken = result == RESULT_BROKEN;
    r.size = size;
    r.orientation = orientation;
    r.tainted = result != RESULT_BROKEN && tainted;
    arena.set_natural_size(id, natural);
    true
}
// What applying a load's result comes to (`imageApply`): nothing, a later load superseding it; else the event the
// element fires — `load`, or `error` for a broken one.
pub(crate) const APPLIED_NONE: u32 = 0;
pub(crate) const APPLIED_LOAD: u32 = 1;
pub(crate) const APPLIED_ERROR: u32 = 2;
// __dom.imageApply(img, load, r) -> `APPLIED_*` of load `load` applied with what its response decoded to — `r` the
// decoder's record (`__dom.decodeImage`'s, a host load's): `{width, height, pixels[, pixelsP3, colorSpace], natural,
// orientation, tainted}` for an image, `{noPixels, …}` for one with none — no area (an SVG whose width or height is 0),
// or data corrupt past the header that gave its size: the request SUCCEEDED, the element complete and not broken, its
// size reported, an available source that is not fully decodable — and null, `{broken}` (no image in what was fetched)
// or `{unsupported}` (a scheme the host fetches nothing of: Chrome's `error`) for a broken one. Complete either way; an
// image's decoded pixels its bitmap — a wide-gamut (Adobe/CMYK) source's Display-P3 rendering too, which a P3 canvas
// draws, and the space drawImage converts from — and its natural size, `natural` (`[width, height, viewBoxWidth,
// viewBoxHeight]`), none for a broken one.
fn apply(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(APPLIED_NONE) };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    let r = v8::Local::<v8::Object>::try_from(args.get(2)).ok();
    rv.set_uint32(apply_record(scope, id, load, r));
}
// …the element `id`'s load `load` applied with the record `r`: `APPLIED_*`.
pub(crate) fn apply_record(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, r: Option<v8::Local<'_, v8::Object>>) -> u32 {
    use crate::dom::member;
    fn field<'s>(scope: &mut v8::PinScope<'s, '_>, r: Option<v8::Local<'_, v8::Object>>, k: &str) -> Option<v8::Local<'s, v8::Value>> {
        r.and_then(|r| member(scope, r, k))
    }
    // (…a flag by its truthiness, as the record's producers' JS reads it)
    let flag = |scope: &mut v8::PinScope<'_, '_>, k: &str| field(scope, r, k).is_some_and(|v| v.boolean_value(scope));
    let number = |scope: &mut v8::PinScope<'_, '_>, k: &str| field(scope, r, k).and_then(|v| v.uint32_value(scope)).unwrap_or(0);
    let pixels = field(scope, r, "pixels");
    let result = if r.is_none() || flag(scope, "broken") || flag(scope, "unsupported") {
        RESULT_BROKEN
    } else if flag(scope, "noPixels") {
        RESULT_NO_PIXELS
    } else if pixels.is_some() {
        RESULT_IMAGE
    } else {
        RESULT_BROKEN
    };
    let image = matches!(result, RESULT_IMAGE | RESULT_NO_PIXELS);
    let (width, height, orientation, tainted) = (number(scope, "width"), number(scope, "height"), number(scope, "orientation"), flag(scope, "tainted"));
    let display_p3 = field(scope, r, "colorSpace").is_some_and(|v| v.to_rust_string_lossy(scope) == "display-p3");
    let p3 = field(scope, r, "pixelsP3");
    let bitmap = pixels
        .filter(|_| result == RESULT_IMAGE)
        .and_then(|p| Pixels::of(scope, p))
        .map(|srgb| Bitmap { srgb, p3: p3.and_then(|p| Pixels::of(scope, p)), display_p3 });
    // (…an Array of the host's, a Float64Array of `decodeImage`'s: read by index either way)
    let natural = field(scope, r, "natural").filter(|_| image).and_then(|n| v8::Local::<v8::Object>::try_from(n).ok()).map(|n| {
        let [w, h, vw, vh] = [0, 1, 2, 3].map(|k| n.get_index(scope, k).and_then(|v| v.number_value(scope)));
        crate::dom::NaturalSize { width: w, height: h, view_box: vw.zip(vh) }
    });
    let arena = &mut crate::dom::dom(scope).arena;
    if load != arena.image_mut(id).load {
        return APPLIED_NONE;
    }
    arena.set_image_bitmap(id, bitmap);
    let r = arena.image_mut(id);
    r.complete = true;
    r.broken = result == RESULT_BROKEN;
    r.size = if image { [width, height] } else { [0, 0] };
    r.orientation = if image { orientation as u8 } else { 0 };
    r.tainted = image && tainted;
    arena.set_natural_size(id, natural);
    if image { APPLIED_LOAD } else { APPLIED_ERROR }
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
    rv.set_uint32(crate::dom::dom(scope).arena.image_load_of(id));
}

// The host fetches load `load` of the `<img>` `node`'s — of realm `realm`'s making — on a thread of its own, as request
// `id`, `src` begun at `start` (`HostFetch`), its result handed back to the realm that began it (`imageFetchTake`).
pub(crate) fn begin_host_fetch(scope: &mut v8::PinScope<'_, '_>, realm: i32, id: u32, node: NodeId, load: u32, src: &str, start: f64) {
    let element = crate::dom::node_value(scope, Some(node));
    let element = v8::Global::new(scope, element);
    crate::dom::dom(scope).arena.image_fetches.insert(id, HostFetch { realm, node, element, load, src: src.to_owned(), start });
}
// __dom.imageFetchTake(id) -> [img, load, src, start] of the host's request `id`, which it hands back — null where it is
// no request the calling realm began (the host offers it to each realm in turn), or one whose element is gone.
fn fetch_take(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(f) = arena.image_fetches.get(&id) else { return rv.set_null() };
    if arena.get(f.node).is_none() {
        arena.image_fetches.remove(&id);
        return rv.set_null();
    }
    if f.realm != cid {
        return rv.set_null();
    }
    let HostFetch { element, load, src, start, .. } = arena.image_fetches.remove(&id).expect("a fetch found above");
    let items: [v8::Local<v8::Value>; 4] = [
        v8::Local::new(scope, &element),
        v8::Integer::new_from_unsigned(scope, load).into(),
        v8::String::new(scope, &src).map_or_else(|| v8::undefined(scope).into(), Into::into),
        v8::Number::new(scope, start).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.imageFetchRealm(id) -> the realm that began the host's request `id` — the one to hand its result to — or -1 for
// none (a request of a realm gone, or of a page left).
fn fetch_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set_int32(crate::dom::dom(scope).arena.image_fetches.get(&id).map_or(-1, |f| f.realm));
}
// __dom.imageArrival(img, load, on) — load `load`'s result, which the calling realm took, is held back by its server's
// delay (`on`), or arrived.
fn arrival(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = element(scope, args.get(0)) else { return };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    let on = args.get(2).is_true();
    let realm = crate::dom::realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    if on {
        // (…and those of elements gone with their realm dropped: none delays anything any more)
        let mut arrivals = std::mem::take(&mut arena.image_arrivals);
        arrivals.retain(|&(_, n, _)| arena.get(n).is_some());
        arrivals.push((realm, node, load));
        arena.image_arrivals = arrivals;
    } else if let Some(i) = arena.image_arrivals.iter().position(|&a| a == (realm, node, load)) {
        arena.image_arrivals.remove(i);
    }
}
