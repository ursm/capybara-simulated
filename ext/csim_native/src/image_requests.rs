// An image element's image requests (HTML §4.8.4.3 "images processing model") — an `<img>`'s, an SVG `<image>`'s, an
// `<input type=image>`'s — and "update the image data", the engine's: its current request and its pending one, each its
// current URL, its state (unavailable, completely available or broken: nothing here is partially available, a resource
// being decoded whole as it lands) and its image data — the decoded image's size, whether it taints a canvas it is drawn
// into, the EXIF turn the decode applied, its natural size and its bitmap, which a canvas draws and the painter paints —
// and the pixel density of its source; which instance of the algorithm was begun last, which alone takes effect at the
// stable state it awaits; the document's list of available images, which a source in it takes at once; and the element
// task each response lands in, which delays its document's load (a load gate: bridge.entry.js `loadGateTask`), fires its
// `load` or `error` and settles the `decode()`s waiting on it (native-query-shadow.js `settleImageDecodes`). The request
// itself — a preload's, a controlling service worker's, the network's — is subresource_obtain.rs `obtain_image`'s. Kept
// per element in the arena (`RealmArena::images`), from its first update.

use crate::dom::{NaturalSize, NodeId, RealmArena};

// A request's state: nothing obtained yet (a fetch under way, or none made), the image whole, or no image.
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Unavailable,
    Complete,
    Broken,
}

// An image request (HTML): its number — what a response for it, and its task, find it by — its current URL ('' for none),
// the pixel density of its source (a `2x` candidate's 2: what its natural size is divided by), its state, its image data,
// the key the list of available images keeps that data under once it is complete (none for a `blob:` URL's, whose bytes
// are its store's), and what its response came to, held for the task that applies it — with the Resource Timing entry
// its host fetch files then, as it ends (`Filing`).
#[derive(Clone)]
struct Request {
    id: u32,
    url: String,
    density: f64,
    state: State,
    data: Option<Data>,
    key: Option<AvailableKey>,
    landed: Option<Landed>,
    filing: Option<Filing>,
}
// A host fetch's entry to file as its response's task runs (subresource_obtain.rs `file_image`): the steps it is filed by,
// the record the host answered with, its URL and its start on the page's clock.
#[derive(Clone)]
struct Filing {
    host: v8::Global<v8::Function>,
    record: Option<v8::Global<v8::Object>>,
    src: String,
    start: f64,
}

impl Request {
    fn new(id: u32, url: String, density: f64) -> Request {
        Request { id, url, density, state: State::Unavailable, data: None, key: None, landed: None, filing: None }
    }
}

// What a response came to: an image — whose data may have no pixels: no area, or data corrupt past the header that gave
// its size; the request SUCCEEDED — or none.
#[derive(Clone)]
enum Landed {
    Image(Data),
    Broken,
}

// An image's data: its decoded size, the EXIF turn the decode applied, whether it taints a canvas it is drawn into, its
// natural size, and its decoded pixels — none for one with no pixels.
#[derive(Clone)]
pub(crate) struct Data {
    size: [u32; 2],
    orientation: u8,
    tainted: bool,
    natural: Option<NaturalSize>,
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

// An image element's requests: its current one, its pending one, the last instance of "update the image data" begun and
// the last whose stable state came, and the number of the last request made.
#[derive(Clone)]
pub(crate) struct ImageRequest {
    current: Request,
    pending: Option<Request>,
    update: u32,
    stable: u32,
    made: u32,
}

impl Default for ImageRequest {
    fn default() -> ImageRequest {
        ImageRequest { current: Request::new(0, String::new(), 1.0), pending: None, update: 0, stable: 0, made: 0 }
    }
}

impl ImageRequest {
    // The request numbered `id`, the current one or the pending one — none where it is neither any more (aborted).
    fn request_mut(&mut self, id: u32) -> Option<&mut Request> {
        if self.current.id == id {
            return Some(&mut self.current);
        }
        self.pending.as_mut().filter(|p| p.id == id)
    }
    fn live(&self, id: u32) -> bool {
        self.current.id == id || self.pending.as_ref().is_some_and(|p| p.id == id)
    }
    // Whether an update of its data is under way: a request pending, or an instance awaiting its stable state.
    fn updating(&self) -> bool {
        self.pending.is_some() || self.stable != self.update
    }
    // A new request for `url` at `density`.
    fn make(&mut self, url: String, density: f64) -> Request {
        self.made += 1;
        Request::new(self.made, url, density)
    }
}

// The list of available images (HTML §4.8.4.3.2) of each realm's document, keyed by the URL and the CORS mode (none for
// No CORS) — and, a CORS one, the document's origin, which is the realm's: the image data of each request that completed,
// which a later "update the image data" for that key takes at once, whatever its response's caching said ("ignore
// higher-layer caching": Chrome reads a `no-store` image's size at once the second time, csim-bench img13 `i2`). The user
// agent may drop an entry at any time: past `AVAILABLE_IMAGES_MAX`, every one goes.
type AvailableKey = (String, Option<String>);
#[derive(Default)]
pub(crate) struct AvailableImages(std::collections::HashMap<(i32, AvailableKey), Data>);
const AVAILABLE_IMAGES_MAX: usize = 1024;

impl AvailableImages {
    fn get(&self, realm: i32, key: &AvailableKey) -> Option<&Data> {
        self.0.get(&(realm, key.clone()))
    }
    fn add(&mut self, realm: i32, key: AvailableKey, data: Data) {
        if self.0.len() >= AVAILABLE_IMAGES_MAX {
            self.0.clear();
        }
        self.0.insert((realm, key), data);
    }
}

// An image's fetch the host makes on a thread of its own (subresource_obtain.rs `image_from_network`): the realm that
// began it — whose document's load it delays, and which takes its result, wherever the element went meanwhile — the
// element — held, as an element whose image is being fetched is kept from being collected — the request it is for, its
// URL, and when it began on the page's clock (its Resource Timing entry's start) and on the event loop's (its server's
// time counts from then: `imageFetchLand`), until the host hands the result back.
pub(crate) struct HostFetch {
    realm: i32,
    node: NodeId,
    _held: v8::Global<v8::Value>,
    load: u32,
    src: String,
    start: f64,
    began: f64,
}

impl RealmArena {
    // What an image element's current request says of it as an image source (canvas_image.rs): whether it is broken,
    // its size, whether it is tainted and whether it has decoded pixels — none while an update of its data is under way
    // (a new request pending, or awaiting the stable state that makes it): not fully decodable, drawn as nothing (WPT
    // 2d.drawImage.incomplete.reload / .removedsrc / .emptysrc, 2d.pattern.image.incomplete.*).
    pub(crate) fn image_source_facts(&self, id: NodeId) -> (bool, [u32; 2], bool, bool) {
        self.image(id).filter(|r| !r.updating()).map_or((false, [0, 0], false, false), |r| {
            let data = r.current.data.as_ref();
            (r.current.state == State::Broken, data.map_or([0, 0], |d| d.size), data.is_some_and(|d| d.tainted), data.is_some_and(|d| d.bitmap.is_some()))
        })
    }
    fn image(&self, id: NodeId) -> Option<&ImageRequest> {
        self.images.get(&id)
    }
    fn image_mut(&mut self, id: NodeId) -> &mut ImageRequest {
        self.images.entry(id).or_default()
    }
    // Whether `id`'s image is coming: its current request made for a URL, nothing obtained yet, or one to be made at the
    // stable state an update awaits — what keeps a sized `<img>` replaced while it loads (walk.rs `img_alt_text`).
    pub(crate) fn image_pending(&self, id: NodeId) -> bool {
        self.image(id).is_some_and(|r| {
            r.current.state == State::Unavailable && (!r.current.url.is_empty() || r.stable != r.update)
        })
    }
    // …the pixel density its current request's source has (1 for none).
    pub(crate) fn image_density(&self, id: NodeId) -> f64 {
        self.image(id).map(|r| r.current.density).filter(|&d| d > 0.0 && d.is_finite()).unwrap_or(1.0)
    }
    // …realm `realm`'s fetches and list of available images forgotten with its nodes: a node id a later page reuses is
    // no image of theirs, and its realm's document delays nothing any more.
    pub(crate) fn forget_image_fetches_of(&mut self, realm: i32) {
        self.image_fetches.retain(|_, f| f.realm != realm);
        self.available_images.0.retain(|(r, _), _| *r != realm);
    }
    // Whether request `load` is `id`'s current or pending one (no later one aborted it).
    pub(crate) fn image_request_live(&self, id: NodeId, load: u32) -> bool {
        self.image(id).is_some_and(|r| r.live(load))
    }
    // Whether realm `realm`'s images delay its document's load event (HTML: an image's fetch in progress does): a live
    // request the host is fetching. (…its response's task, once it has one, is a load gate: `queue_task`)
    pub(crate) fn images_delay_load(&self, realm: i32) -> bool {
        self.image_fetches.values().any(|f| f.realm == realm && self.get(f.node).is_some() && self.image_request_live(f.node, f.load))
    }
    // The current request's image data become `data` (none: no image), its natural size laid out by it — and what the
    // element shows moved, its box laid out again before an event a listener reads its size in, in the realm whose tree
    // it is in.
    fn show(&mut self, id: NodeId, data: Option<&Data>) {
        self.set_natural_size(id, data.and_then(|d| d.natural));
        if let Some(cid) = self.get(id).map(|n| n.realm) {
            self.enter(cid).note_shown_changed(1);
        }
    }
    // The EXIF turn its decode applied, which `imageOrientation: "flipY"` undoes (0 for no image).
    pub(crate) fn image_orientation(&self, id: NodeId) -> u8 {
        self.image(id).and_then(|r| r.current.data.as_ref()).map_or(0, |d| d.orientation)
    }
    // Its NATURAL size: its size over its source's pixel density.
    pub(crate) fn image_natural_size(&self, id: NodeId) -> [u32; 2] {
        let d = self.image_density(id);
        self.image(id).and_then(|r| r.current.data.as_ref()).map_or([0, 0], |data| data.size.map(|v| (f64::from(v) / d).trunc() as u32))
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "imageUpdate", update_op, context_id);
    crate::dom::register(scope, ns, "imageFetchesStop", fetches_stop, context_id);
    crate::dom::register(scope, ns, "imageInfo", info, context_id);
    crate::dom::register(scope, ns, "imageUrl", url, context_id);
    crate::dom::register(scope, ns, "imageBitmap", bitmap_op, context_id);
    crate::dom::register(scope, ns, "imageFetchRealm", fetch_realm, context_id);
    crate::dom::register(scope, ns, "imageFetchLand", fetch_land, context_id);
}

fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    crate::node_handle::nid_of(scope, value)
}

// Which of the image elements an element is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Img,
    SvgImage,
    InputImage,
}
fn kind_of(n: &crate::dom::NodeData) -> Option<Kind> {
    if n.is_html_named("img") {
        Some(Kind::Img)
    } else if n.is_html_named("input") && n.plain_attr("type").is_some_and(|t| t.eq_ignore_ascii_case("image")) {
        Some(Kind::InputImage)
    } else if n.kind == crate::dom::NodeKind::Element && n.ns == web_atoms::ns!(svg) && &*n.local_name == "image" {
        Some(Kind::SvgImage)
    } else {
        None
    }
}
// Whether an `<img>` "uses srcset or picture": it has a `srcset`, or its parent is a `<picture>`.
fn uses_srcset_or_picture(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.plain_attr("srcset").is_some())
        || arena.parent_of(id).and_then(|p| arena.get(p)).is_some_and(|p| p.is_html_named("picture"))
}
// The source the element's own attribute names, as the first steps of "update the image data" take it: an `<img>`'s
// `src` where it uses no `srcset` or `<picture>` (none where it does), an SVG `<image>`'s `href` — its XLink one where it
// has none (SVG 2: an empty `href` still wins, as in Chrome and Firefox) — an `<input type=image>`'s `src`.
fn own_source(arena: &RealmArena, id: NodeId, kind: Kind) -> Option<String> {
    let n = arena.get(id)?;
    match kind {
        Kind::Img => n.plain_attr("src").filter(|_| !uses_srcset_or_picture(arena, id)).map(str::to_owned),
        Kind::SvgImage => n.plain_attr("href").or_else(|| n.ns_attr("http://www.w3.org/1999/xlink", "href")).map(str::to_owned),
        Kind::InputImage => n.plain_attr("src").map(str::to_owned),
    }
}
// …and "selecting an image source" at the stable state: an `<img>`'s picture's selected `<source>`'s candidates, or its
// own `srcset`'s, over its `src` (image_source.rs `select`, a `media` judged on its realm's viewport) — with the pixel
// density of the one chosen — the others' own.
pub(crate) fn select_source(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId) -> Option<(String, f64)> {
    let kind = crate::dom::realm(scope, cid).get(id).and_then(kind_of)?;
    if kind != Kind::Img {
        return own_source(crate::dom::realm(scope, cid), id, kind).map(|s| (s, 1.0));
    }
    let viewport = crate::viewport::of(scope, cid).map(|v| v as f32);
    let d = crate::dom::dom(scope);
    let screen = crate::style::Screen { viewport: (viewport[0], viewport[1]), touch: d.touch_input };
    let arena = d.arena.enter_known(cid)?;
    let engine = d.styles.get(&cid);
    crate::image_source::select(arena, id, &|media| crate::style::media_matches(engine, arena, screen, media))
}

// What a caller of "update the image data" says of it: its stable state has come already (the parser's images: the
// parser performs a microtask checkpoint before a script runs).
const STABLE: u32 = 1;

// __dom.imageUpdate(el, flags, host) — HTML "update the image data" for the image element `el` of the calling realm's
// document, a fully active one (any other loads nothing: a DOMParser's, `createHTMLDocument`'s, template contents', one
// navigated away from — Chrome: a DOMParser document's image has no size, whatever sets its source), `flags` `STABLE`
// where its stable state has come, `host` the steps its request is made by (subresource-host.js):
//   - an `<img>` that names no source of its own and uses no `srcset` or `<picture>` drops what it has at once — its
//     requests aborted, the current one broken with no URL: Chrome and Firefox read `complete` and a 0 `naturalWidth`
//     right after `src` is emptied or removed (csim-bench img13 `i5`);
//   - a source of its own in the list of available images is taken at once: the current request completely available
//     with that entry's data, its URL set and its `load` fired as an element task (`take_available`);
//   - else the stable state is awaited (a microtask), where only the last instance begun takes effect (`stable_state`).
fn update_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let flags = args.get(1).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let Some(doc) = crate::dom::node_document(scope, id) else { return };
    let arena = crate::dom::realm(scope, cid);
    if !arena.document_fully_active(doc) {
        return;
    }
    let Some(kind) = arena.get(id).and_then(kind_of) else { return };
    let source = own_source(arena, id, kind);
    if kind == Kind::Img && source.as_deref().is_none_or(str::is_empty) && !uses_srcset_or_picture(arena, id) {
        // (…an `<img>` that never had a source has nothing to drop, nor an `error` to fire: it stays as it was made)
        if arena.image(id).is_none() && source.is_none() {
            return;
        }
        abort_all(scope, cid, id, State::Broken);
    } else if let Some(url) = source.filter(|s| !s.is_empty()).and_then(|s| arena.parse_document_url(doc, &s)) {
        let key = available_key(arena, id, url.href());
        if let Some(data) = arena.available_images.get(cid, &key).cloned() {
            take_available(scope, cid, id, key, data);
            return;
        }
    }
    let r = crate::dom::realm(scope, cid).image_mut(id);
    r.update += 1;
    let update = r.update;
    if flags & STABLE != 0 {
        stable_state(scope, cid, id, update, host);
        return;
    }
    let el = crate::dom::node_value(scope, Some(id));
    let (n, host, realm) = (v8::Integer::new_from_unsigned(scope, update).into(), host.into(), v8::Integer::new(scope, cid).into());
    let data = v8::Array::new_with_elements(scope, &[el, n, host, realm]);
    let Some(step) = v8::Function::builder(run_stable_state).data(data.into()).build(scope) else { return };
    crate::dom::call_host_step(scope, "queueMicrotask", &[step.into()]);
}
// (…the microtask: the stable state come)
fn run_stable_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(data) = v8::Local::<v8::Array>::try_from(args.data()) else { return };
    let [el, n, host, realm] = [0, 1, 2, 3].map(|i| data.get_index(scope, i).unwrap_or_else(|| v8::undefined(scope).into()));
    let (Some(id), Ok(host)) = (element(scope, el), v8::Local::<v8::Function>::try_from(host)) else { return };
    let (update, cid) = (n.uint32_value(scope).unwrap_or(0), realm.int32_value(scope).unwrap_or(0));
    stable_state(scope, cid, id, update, host);
}
// The key of `url` in the list of available images, for the element's CORS mode.
fn available_key(arena: &RealmArena, id: NodeId, url: &str) -> AvailableKey {
    let mode = arena.get(id).and_then(|n| n.plain_attr("crossorigin")).map(|m| if m.eq_ignore_ascii_case("use-credentials") { "use-credentials" } else { "anonymous" });
    (url.to_owned(), mode.map(str::to_owned))
}
// The element's requests aborted — the current one and the pending one (HTML "abort the image request": their data
// forgotten, their fetches' tasks dropped) — and `request` its current one, none pending: what it shows its data, and
// the `decode()`s waiting on the one it replaces rejected (the current request changed).
fn replace_current(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, request: Request) {
    let arena = crate::dom::realm(scope, cid);
    let r = arena.image_mut(id);
    let shown = r.current.data.is_some() || request.data.is_some();
    r.current = request;
    r.pending = None;
    let data = r.current.data.clone();
    if shown {
        arena.show(id, data.as_ref());
    }
    let el = crate::dom::node_value(scope, Some(id));
    settle_decodes(scope, el, false);
}
// …one of no URL and no image data, `state`: an `<img>`'s broken (HTML), an SVG `<image>`'s or an `<input type=image>`'s
// with no source none at all — nothing to draw, nothing broken (Chrome and Firefox: no pattern of one, no exception).
fn abort_all(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, state: State) {
    let made = crate::dom::realm(scope, cid).image_mut(id).make(String::new(), 1.0);
    replace_current(scope, cid, id, Request { state, ..made });
}
// …and the list of available images' entry for `key` taken (HTML "update the image data" step 8): a new current request
// completely available with its data, and an element task queued that sets its URL and fires `load`.
fn take_available(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, key: AvailableKey, data: Data) {
    let r = crate::dom::realm(scope, cid).image_mut(id);
    r.update += 1;
    r.stable = r.update;
    let made = r.make(String::new(), 1.0);
    let load = made.id;
    replace_current(scope, cid, id, Request { state: State::Complete, data: Some(data), key: Some(key), ..made });
    queue_task(scope, id, load, Task::Available, 0.0);
}

// "Update the image data"'s synchronous section, at the stable state, for instance `update` — nothing where a later one
// was begun since: the source selected (`select_source`) — none, the requests aborted and the current one broken, its
// `error` fired as an element task where the element has a `src` or uses a `srcset` or a `<picture>`; one that parses to
// no URL the same, its URL the source (Chrome); one the pending request is for already, nothing more — then a new request,
// the current one where the current one has no image (unavailable or broken), else the pending one, the current one shown
// meanwhile (Firefox: `naturalWidth` and `currentSrc` the old image's until the new one's `load`, where Chrome drops it at
// once, `i3`) — and made (subresource_obtain.rs `obtain_image`).
fn stable_state(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, update: u32, host: v8::Local<'_, v8::Function>) {
    let arena = crate::dom::realm(scope, cid);
    if arena.image(id).is_none_or(|r| r.update != update) || arena.get(id).is_none() {
        return;
    }
    arena.image_mut(id).stable = update;
    let Some(doc) = crate::dom::node_document(scope, id) else { return };
    if !crate::dom::realm(scope, cid).document_fully_active(doc) {
        return;
    }
    let selected = select_source(scope, cid, id);
    let arena = crate::dom::realm(scope, cid);
    let Some((source, density)) = selected.filter(|(s, _)| !s.is_empty()) else {
        let img = arena.get(id).and_then(kind_of) == Some(Kind::Img);
        let fires = img && (arena.get(id).is_some_and(|n| n.plain_attr("src").is_some()) || uses_srcset_or_picture(arena, id));
        abort_all(scope, cid, id, if img { State::Broken } else { State::Unavailable });
        if fires {
            let load = crate::dom::realm(scope, cid).image_mut(id).current.id;
            queue_task(scope, id, load, Task::Error, 0.0);
        }
        return;
    };
    let Some(url) = arena.parse_document_url(doc, &source).map(|u| u.href().to_owned()) else {
        abort_all(scope, cid, id, State::Broken);
        let r = crate::dom::realm(scope, cid).image_mut(id);
        r.current.url = source;
        let load = r.current.id;
        queue_task(scope, id, load, Task::Error, 0.0);
        return;
    };
    let key = (!url.starts_with("blob:")).then(|| available_key(arena, id, &url));
    let r = arena.image_mut(id);
    // (…nor one the current request is coming from still — as HTML has it for one partially available, a resource here
    // being nothing until it is whole: a parsed image re-appended fetches it once)
    let coming = r.current.state == State::Unavailable && r.current.url == url && r.pending.is_none();
    if coming || r.pending.as_ref().is_some_and(|p| p.url == url) {
        return;
    }
    let mut request = r.make(url.clone(), density);
    request.key = key;
    let load = request.id;
    if r.current.state == State::Complete {
        r.pending = Some(request);
    } else {
        replace_current(scope, cid, id, request);
    }
    crate::subresource_obtain::obtain_image(scope, host, cid, id, doc, url, load);
}

// What an element task of an image's carries out (`run_task`): a request's response landed — its data shown, its `load`
// or its `error` fired — an entry of the list of available images taken (its URL set, its `load` fired), a source that
// failed before any request (its `error`), or a request whose document's abort cancelled its fetch (broken, no event).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Task {
    Landed = 0,
    Available = 1,
    Error = 2,
    Cancelled = 3,
}

// Request `load` of the element `id` — current or pending — landed with what its response came to, its element task
// queued `due` ms from now: whether it was live still (no later request aborted it).
fn land(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, landed: Landed, due: f64) -> bool {
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(r) = arena.images.get_mut(&id) else { return false };
    let current = r.current.id == load;
    let Some(request) = r.request_mut(load) else { return false };
    // (…a broken current request's `decode()`s rejected as it is known, ahead of its `error`: Chrome and Firefox, `i7`)
    let rejects = current && matches!(landed, Landed::Broken);
    request.landed = Some(landed);
    if rejects {
        let el = crate::dom::node_value(scope, Some(id));
        settle_decodes(scope, el, false);
    }
    queue_task(scope, id, load, Task::Landed, due);
    true
}
// …with an image decoded here (`decoded`: none for none), `tainted` its response's CORS-cross-origin, its task queued now.
pub(crate) fn land_decoded(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, decoded: Option<crate::image_decode::Bitmap>, tainted: bool) -> bool {
    if !crate::dom::dom(scope).arena.image_request_live(id, load) {
        return false;
    }
    let landed = match decoded {
        None => Landed::Broken,
        Some(b) => {
            let bitmap = if b.rgba.is_empty() {
                None
            } else {
                let srgb = crate::dom::u8_clamped_array(scope, b.rgba);
                let p3 = b.rgba_p3.map(|p| crate::dom::u8_clamped_array(scope, p));
                Pixels::of(scope, srgb).map(|srgb| Bitmap { srgb, p3: p3.and_then(|p| Pixels::of(scope, p)), display_p3: b.display_p3 })
            };
            Landed::Image(Data { size: [b.width, b.height], orientation: b.orientation, tainted, natural: Some(b.natural), bitmap })
        }
    };
    land(scope, id, load, landed, 0.0)
}
// …with the host decoder's record `r` (a host load's): `{width, height, pixels[, pixelsP3, colorSpace], natural,
// orientation, tainted}` for an image, `{noPixels, …}` for one with none — no area (an SVG whose width or height is 0), or
// data corrupt past the header that gave its size — and null, `{broken}` (no image in what was fetched) or `{unsupported}`
// (a scheme the host fetches nothing of: Chrome's `error`) for none; its task queued `due` ms from now.
pub(crate) fn land_record(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, r: Option<v8::Local<'_, v8::Object>>, due: f64) -> bool {
    use crate::dom::member;
    fn field<'s>(scope: &mut v8::PinScope<'s, '_>, r: Option<v8::Local<'_, v8::Object>>, k: &str) -> Option<v8::Local<'s, v8::Value>> {
        r.and_then(|r| member(scope, r, k))
    }
    if !crate::dom::dom(scope).arena.image_request_live(id, load) {
        return false;
    }
    // (…a flag by its truthiness, as the record's producers' JS reads it)
    let flag = |scope: &mut v8::PinScope<'_, '_>, k: &str| field(scope, r, k).is_some_and(|v| v.boolean_value(scope));
    let number = |scope: &mut v8::PinScope<'_, '_>, k: &str| field(scope, r, k).and_then(|v| v.uint32_value(scope)).unwrap_or(0);
    let pixels = field(scope, r, "pixels");
    let no_pixels = flag(scope, "noPixels");
    let image = r.is_some() && !flag(scope, "broken") && !flag(scope, "unsupported") && (no_pixels || pixels.is_some());
    let landed = if image {
        let display_p3 = field(scope, r, "colorSpace").is_some_and(|v| v.to_rust_string_lossy(scope) == "display-p3");
        let p3 = field(scope, r, "pixelsP3");
        let bitmap = pixels
            .filter(|_| !no_pixels)
            .and_then(|p| Pixels::of(scope, p))
            .map(|srgb| Bitmap { srgb, p3: p3.and_then(|p| Pixels::of(scope, p)), display_p3 });
        // (…an Array of the host's, a Float64Array of a decode's: read by index either way)
        let natural = field(scope, r, "natural").and_then(|n| v8::Local::<v8::Object>::try_from(n).ok()).map(|n| {
            let [w, h, vw, vh] = [0, 1, 2, 3].map(|k| n.get_index(scope, k).and_then(|v| v.number_value(scope)));
            NaturalSize { width: w, height: h, view_box: vw.zip(vh) }
        });
        let size = [number(scope, "width"), number(scope, "height")];
        Landed::Image(Data { size, orientation: number(scope, "orientation") as u8, tainted: flag(scope, "tainted"), natural, bitmap })
    } else {
        Landed::Broken
    };
    land(scope, id, load, landed, due)
}

// An element task of the image `id`'s for request `load` queued `due` ms from now (HTML "queue an element task on the DOM
// manipulation task source"), its document's load waiting for it (a load gate, whose due a visit steps the event loop to:
// frame_navigation.rs `loadDueIn`).
fn queue_task(scope: &mut v8::PinScope<'_, '_>, id: NodeId, load: u32, task: Task, due: f64) {
    let el = crate::dom::node_value(scope, Some(id));
    let (n, t) = (v8::Integer::new_from_unsigned(scope, load).into(), v8::Integer::new_from_unsigned(scope, task as u32).into());
    let data = v8::Array::new_with_elements(scope, &[el, n, t]);
    let Some(step) = v8::Function::builder(run_task).data(data.into()).build(scope) else { return };
    // (…a cancelled one's no more: its document's abort delays the load by none of its fetches)
    if task == Task::Cancelled {
        crate::timers::queue_task(scope, step);
        return;
    }
    let due = v8::Number::new(scope, due.max(0.0)).into();
    crate::dom::call_host_step(scope, "loadGateTask", &[el, step.into(), due]);
}
fn run_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(data) = v8::Local::<v8::Array>::try_from(args.data()) else { return };
    let [el, n, t] = [0, 1, 2].map(|i| data.get_index(scope, i).unwrap_or_else(|| v8::undefined(scope).into()));
    let Some(id) = element(scope, el) else { return };
    let load = n.uint32_value(scope).unwrap_or(0);
    let t = t.uint32_value(scope).unwrap_or(0);
    let Some(task) = [Task::Landed, Task::Available, Task::Error, Task::Cancelled].into_iter().find(|&k| k as u32 == t) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(r) = arena.images.get_mut(&id).filter(|r| r.live(load)) else { return };
    let loaded = match task {
        // (…its URL, the entry's, set now)
        Task::Available => {
            if let Some((url, _)) = r.current.key.clone() {
                r.current.url = url;
            }
            true
        }
        Task::Error => false,
        Task::Cancelled => {
            if r.pending.as_ref().is_some_and(|p| p.id == load) {
                r.pending = None;
            } else {
                r.current.state = State::Broken;
            }
            settle_decodes(scope, el, false);
            return;
        }
        Task::Landed => {
            // (…a pending one upgraded to the current request: the old one's data dropped for its)
            if r.pending.as_ref().is_some_and(|p| p.id == load) {
                r.current = r.pending.take().expect("a pending request found above");
            }
            let Some(landed) = r.current.landed.take() else { return };
            if let Some(f) = r.current.filing.take() {
                let (host, record) = (v8::Local::new(scope, &f.host), f.record.map(|r| v8::Local::new(scope, r)));
                if crate::subresource_obtain::file_image(scope, host, id, &f.src, f.start, record).is_err() {
                    return;
                }
            }
            let arena = &mut crate::dom::dom(scope).arena;
            let Some(r) = arena.images.get_mut(&id).filter(|r| r.current.id == load) else { return };
            let data = match landed {
                Landed::Image(data) => {
                    r.current.state = State::Complete;
                    Some(data)
                }
                Landed::Broken => {
                    r.current.state = State::Broken;
                    None
                }
            };
            r.current.data = data.clone();
            if let (Some(key), Some(data)) = (r.current.key.clone(), data.clone()) {
                let realm = arena.get(id).map_or(0, |n| n.realm);
                arena.available_images.add(realm, key, data);
            }
            arena.show(id, data.as_ref());
            data.is_some()
        }
    };
    settle_decodes(scope, el, loaded);
    let ty = v8::String::new(scope, if loaded { "load" } else { "error" }).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let no = v8::Boolean::new(scope, false).into();
    crate::dom::call_host_step(scope, "fireSimpleEvent", &[el, ty, no]);
}
// (…the `decode()`s waiting on the element's current request: resolved where it loaded, rejected where it did not)
fn settle_decodes(scope: &mut v8::PinScope<'_, '_>, el: v8::Local<'_, v8::Value>, loaded: bool) {
    let loaded = v8::Boolean::new(scope, loaded).into();
    crate::dom::call_host_step(scope, "settleImageDecodes", &[el, loaded]);
}

// __dom.imageFetchesStop() -> how many requests of the calling realm's document's images its abort cancelled (HTML "abort
// a document": "cancel any instance of the fetch algorithm in the context of document, discarding any tasks queued for
// them") — each the host is fetching, or whose response's task is still to run — its response landing into nothing,
// delaying the load no more, broken on an element task with no event, as Firefox has it, where Chrome fires `error`. An
// instance whose stable state has not come has made no request yet: it goes on to its `load` or its `error` as it would —
// Chrome and Firefox, with a real image, for an `src` set, a node inserted or a `document.write` in the same task as the
// `stop()` (rvfn x_real_*, 2026-11-06).
fn fetches_stop(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    let mut stopped: Vec<(NodeId, u32)> = arena.image_fetches.values().filter(|f| f.realm == cid).map(|f| (f.node, f.load)).collect();
    arena.image_fetches.retain(|_, f| f.realm != cid);
    let ours: Vec<NodeId> = arena.images.keys().copied().filter(|&id| arena.get(id).is_some_and(|n| n.realm == cid)).collect();
    for id in ours {
        let Some(r) = arena.images.get_mut(&id) else { continue };
        for request in std::iter::once(&mut r.current).chain(r.pending.as_mut()) {
            if request.landed.take().is_some() {
                stopped.push((id, request.id));
            }
        }
    }
    stopped.retain(|&(id, load)| arena.image_request_live(id, load));
    rv.set_uint32(stopped.len() as u32);
    for (id, load) in stopped {
        queue_task(scope, id, load, Task::Cancelled, 0.0);
    }
}

// __dom.imageInfo(img) -> [complete, broken, width, height, tainted, orientation, density]: the current request, as the
// element's members and a canvas read it — its decoded bitmap's size, and its source's pixel density, which the natural
// size is that size divided by. `complete` HTML's: no `src` and no `srcset`, or no `srcset` and an empty `src`, or the
// current request completely available or broken with none pending — and no instance of "update the image data" awaiting
// its stable state, which makes the request that is pending: false at once after an `src` is set (WPT
// the-img-element/img.complete "async pending request test"; Chrome and Firefox, csim-bench img13 `i3`).
fn info(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let arena = &crate::dom::dom(scope).arena;
    let sourceless = arena.get(id).is_some_and(|n| n.plain_attr("srcset").is_none() && n.plain_attr("src").is_none_or(str::is_empty));
    let (settled, broken, data) = match arena.image(id) {
        Some(r) => (!r.updating() && r.current.state != State::Unavailable, r.current.state == State::Broken, r.current.data.clone()),
        None => (false, false, None),
    };
    let density = arena.image_density(id);
    let (size, tainted, orientation) = data.map_or(([0, 0], false, 0), |d| (d.size, d.tainted, d.orientation));
    let items = [
        v8::Boolean::new(scope, sourceless || settled).into(),
        v8::Boolean::new(scope, broken).into(),
        v8::Integer::new_from_unsigned(scope, size[0]).into(),
        v8::Integer::new_from_unsigned(scope, size[1]).into(),
        v8::Boolean::new(scope, tainted).into(),
        v8::Integer::new_from_unsigned(scope, u32::from(orientation)).into(),
        v8::Number::new(scope, density).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// What a draw or a pattern reads of an image element's decoded bitmap: its pixels, its Display P3 ones, whether the first
// are Display P3 values.
pub(crate) fn source_pixels<'s>(scope: &mut v8::PinScope<'s, '_>, id: NodeId) -> Option<(v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>, bool)> {
    let b = crate::dom::dom(scope).arena.image(id).and_then(|r| r.current.data.as_ref()).and_then(|d| d.bitmap.clone())?;
    let p3 = match &b.p3 {
        Some(p) => p.view(scope),
        None => v8::null(scope).into(),
    };
    Some((b.srgb.view(scope), p3, b.display_p3))
}
// __dom.imageBitmap(img) -> [pixels, pixelsP3 | null, displayP3] — views on the current request's decoded bitmap — or
// null where it has none.
fn bitmap_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let Some((srgb, p3, display_p3)) = source_pixels(scope, id) else { return rv.set_null() };
    let items = [srgb, p3, v8::Boolean::new(scope, display_p3).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.imageUrl(img) -> the current request's current URL ('' for none): what `currentSrc` reads.
fn url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = element(scope, args.get(0)).and_then(|id| crate::dom::dom(scope).arena.image(id)).map(|r| r.current.url.clone()).unwrap_or_default();
    rv.set(v8::String::new(scope, &url).map_or_else(|| v8::undefined(scope).into(), Into::into));
}

// The host fetches request `load` of the image `node`'s — of realm `realm`'s making — on a thread of its own, as host
// request `id`, `src` begun at `start` on the page's clock (`HostFetch`), its result handed back to the realm that began
// it (`imageFetchLand`).
pub(crate) fn begin_host_fetch(scope: &mut v8::PinScope<'_, '_>, realm: i32, id: u32, node: NodeId, load: u32, src: &str, start: f64) {
    let element = crate::dom::node_value(scope, Some(node));
    let _held = v8::Global::new(scope, element);
    let arena = &mut crate::dom::dom(scope).arena;
    let began = arena.event_loop.clock;
    arena.image_fetches.insert(id, HostFetch { realm, node, _held, load, src: src.to_owned(), start, began });
}
// __dom.imageFetchLand(id, r, host) -> whether the host's request `id` was one the calling realm began (the host offers it
// to each realm in turn): its record `r` landed (`land_record`), its entry filed as its task runs (subresource_obtain.rs
// `file_image`), that task as far after it began as its server took — its sleeps (`slept`) and its modeled delay (`meta.delayMs`, a WPT
// handler's virtualized `time.sleep`), virtual ms on the event loop's clock. Nothing lands of one whose element is gone,
// nor of one a later request aborted, which files nothing either.
fn fetch_land(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return rv.set_bool(false) };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(f) = arena.image_fetches.get(&id) else { return rv.set_bool(false) };
    if arena.get(f.node).is_none() {
        arena.image_fetches.remove(&id);
        return rv.set_bool(false);
    }
    if f.realm != cid {
        return rv.set_bool(false);
    }
    let HostFetch { node, load, src, start, began, .. } = arena.image_fetches.remove(&id).expect("a fetch found above");
    rv.set_bool(true);
    if !arena.image_request_live(node, load) {
        return;
    }
    let r = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    let ms = |scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, k: &str| {
        obj.and_then(|o| crate::dom::member(scope, o, k)).and_then(|v| v.number_value(scope)).filter(|v| v.is_finite()).unwrap_or(0.0)
    };
    let meta = r.and_then(|r| crate::dom::member(scope, r, "meta")).and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let took = ms(scope, r, "slept") + ms(scope, meta, "delayMs");
    let due = began + took - crate::dom::dom(scope).arena.event_loop.clock;
    let filing = Filing { host: v8::Global::new(scope, host), record: r.map(|r| v8::Global::new(scope, r)), src, start };
    if let Some(request) = crate::dom::dom(scope).arena.images.get_mut(&node).and_then(|i| i.request_mut(load)) {
        request.filing = Some(filing);
    }
    land_record(scope, node, load, r, due);
}
// __dom.imageFetchRealm(id) -> the realm that began the host's request `id` — the one to hand its result to — or -1 for
// none (a request of a realm gone, or of a page left).
fn fetch_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set_int32(crate::dom::dom(scope).arena.image_fetches.get(&id).map_or(-1, |f| f.realm));
}
