// A media element's state (HTML §4.8.11) — `<video>` and `<audio>` — and its algorithms, the engine's: its network and
// ready states, the resource its load algorithm last selected, its playback position, duration and paused-ness, its
// rates, volume and mutedness, the error its last load failed with, a decoded video's size, and which load is the
// current one; the media element load algorithm, the resource selection algorithm with its `<source>` candidates (its
// synchronous sections at the stable state they await), the resource fetch algorithm as far as nothing streams — a
// resource is fetched whole, a video's decoded to its size, duration and first frame (video.rs), an audio's not decoded
// at all, its duration read off its container (audio.rs) — +Infinity where it says none, as HTML has it for one "not
// known" — and the media data processing steps,
// each event the element owes fired from a media element task (`queue_task`) at its own turn, the document's load waiting
// on the element's delaying-the-load-event flag until it has its first frame (`loadeddata`). The bindings only call in
// (media.js) and
// keep the MediaError and TimeRanges objects. Kept per element in the arena (`RealmArena::media`), from its first use.

use crate::dom::{NodeId, RealmArena};

// The network states (HTMLMediaElement's constants).
const NETWORK_EMPTY: u8 = 0;
const NETWORK_IDLE: u8 = 1;
const NETWORK_LOADING: u8 = 2;
const NETWORK_NO_SOURCE: u8 = 3;
// The ready states that matter here: none, the metadata, and all the data there is (nothing streams: a resource is all
// there as its metadata is).
const HAVE_NOTHING: u8 = 0;
const HAVE_METADATA: u8 = 1;
const HAVE_CURRENT_DATA: u8 = 2;
const HAVE_ENOUGH_DATA: u8 = 4;
// MediaError's code for a source that could not be loaded or decoded.
const MEDIA_ERR_SRC_NOT_SUPPORTED: u8 = 4;

#[derive(Clone)]
pub(crate) struct Media {
    network: u8,
    ready: u8,
    current_src: String,
    // The official playback position, and the default playback start position: a seek made with no media data, which
    // the position takes once there is some (HTML §4.8.11.8) — what `currentTime` reads meanwhile, where it is not 0.
    current_time: f64,
    default_start: f64,
    // NaN with no media data.
    duration: f64,
    playing: bool,
    default_rate: f64,
    rate: f64,
    preserves_pitch: bool,
    volume: f64,
    muted: bool,
    // The MediaError code the last load failed with, 0 for none — and how many failures there have been, which the
    // bindings key the error's object on (one object per failure).
    error: u8,
    failures: u32,
    video_size: [u32; 2],
    // Whether the decoded frame taints a canvas it is drawn into (clears its origin-clean flag): its resource an opaque
    // response — a no-cors cross-origin one — which a failed load discards with the frame.
    tainted: bool,
    // Which load is the current one: a later load supersedes what an earlier one had queued.
    load: u32,
    // Whether the current load's resource fetch waits for its trigger — `preload` none — and whether that trigger came:
    // the page asked it to play, which no fetch of the load waits for after (`fetch_selected`, `mediaPlay`).
    deferred: bool,
    play_requested: bool,
    // Whether the current load selects among the `<source>` children — the children mode, whose candidate's failure is
    // the candidate's, not the element's — its candidate, none once it is removed from the element, and its pointer: the
    // child it follows, none before the first (the candidate, or the one before a child it followed that was removed:
    // `media_child_detached`); `waiting` where every candidate failed, the algorithm awaiting a `<source>` inserted past
    // it (`source_inserted`).
    children: bool,
    candidate: Option<NodeId>,
    pointer: Option<NodeId>,
    waiting: bool,
    // Its delaying-the-load-event flag (HTML §4.8.11.5): set as its resource selection begins, unset once it has its
    // first frame, fails, waits for a candidate, or puts its fetch off — what its document's load waits on meanwhile
    // (`media_delays_load`).
    delaying: bool,
    // When, on the event loop's clock, the task its resource's fetch lands in is due (as far after the fetch as its server
    // took): what a visit steps to while it delays the load (`media_delays_load`, frame_navigation.rs `loadDueIn`).
    due: f64,
}

// An element's state before its first use.
static INITIAL: Media = Media {
    network: NETWORK_EMPTY,
    ready: HAVE_NOTHING,
    current_src: String::new(),
    current_time: 0.0,
    default_start: 0.0,
    duration: f64::NAN,
    playing: false,
    default_rate: 1.0,
    rate: 1.0,
    preserves_pitch: true,
    volume: 1.0,
    muted: false,
    error: 0,
    failures: 0,
    video_size: [0, 0],
    tainted: false,
    load: 0,
    deferred: false,
    play_requested: false,
    children: false,
    candidate: None,
    pointer: None,
    waiting: false,
    delaying: false,
    due: 0.0,
};

impl Default for Media {
    fn default() -> Media {
        INITIAL.clone()
    }
}

impl Media {
    // What `currentTime` reads: the default playback start position while there is no media data and it is not 0.
    fn current_time(&self) -> f64 {
        if self.ready == HAVE_NOTHING && self.default_start != 0.0 { self.default_start } else { self.current_time }
    }
}

impl RealmArena {
    // What a video element says of itself as an image source (canvas_image.rs): its decoded frame's size — none where it
    // has none — and whether that frame taints a canvas.
    pub(crate) fn video_source_facts(&self, id: NodeId) -> (Option<[u32; 2]>, bool) {
        let m = self.media(id);
        (self.video_frames.contains_key(&id).then_some(m.video_size), m.tainted)
    }
    fn media(&self, id: NodeId) -> &Media {
        self.media.get(&id).unwrap_or(&INITIAL)
    }
    fn media_mut(&mut self, id: NodeId) -> &mut Media {
        self.media.entry(id).or_default()
    }
    // A child taken out of a media element (§4.8.11.5): the candidate it was no longer one — its failure no `error` at
    // it — and a pointer that followed it now follows the child before it, the pointer sitting between nodes.
    pub(crate) fn media_child_detached(&mut self, media: NodeId, child: NodeId) {
        let Some(n) = self.get(media) else { return };
        let m = self.media(media);
        if m.candidate != Some(child) && m.pointer != Some(child) {
            return;
        }
        let before = n.children.iter().position(|&c| c == child).and_then(|at| at.checked_sub(1)).map(|at| n.children[at]);
        let m = self.media_mut(media);
        if m.candidate == Some(child) {
            m.candidate = None;
        }
        if m.pointer == Some(child) {
            m.pointer = before;
        }
    }
    // HTMLSourceElement's insertion steps (HTML §4.8.11.2 `source`): into a media element with no `src` whose network
    // state is EMPTY, the resource selection algorithm invoked — its first step, NO_SOURCE, its rest as the stable state
    // comes — `Some((load, false))`; into one whose children mode waits for a candidate, past its pointer, the wait over —
    // the next candidate tried as the stable state comes — `Some((load, true))`.
    fn source_inserted(&mut self, media: NodeId, source: NodeId) -> Option<(u32, bool)> {
        let n = self.get(media).filter(|n| is_media(n))?;
        let at = |node: NodeId| n.children.iter().position(|&c| c == node);
        let index = at(source)?;
        let m = self.media(media);
        if m.network == NETWORK_EMPTY && n.plain_attr("src").is_none() {
            let m = self.media_mut(media);
            m.network = NETWORK_NO_SOURCE;
            m.delaying = true;
            return Some((m.load, false));
        }
        if !m.waiting || m.pointer.and_then(at).is_some_and(|pointer| index < pointer) {
            return None;
        }
        let m = self.media_mut(media);
        m.waiting = false;
        Some((m.load, true))
    }
}

pub(crate) fn is_media(n: &crate::dom::NodeData) -> bool {
    n.is_html_named("video") || n.is_html_named("audio")
}
impl RealmArena {
    // A media element created with its attributes — the parser's, a clone's: one with a `muted` attribute muted (HTML
    // §4.8.11.13: "when a media element is created, if the element has a muted content attribute specified, then the
    // muted IDL attribute should be set to true"); one an `setAttribute('muted')` gave it later not (Chrome and Firefox
    // reject its play() as an unmuted one's, csim-bench img13 `m9`).
    pub(crate) fn media_created(&mut self, id: NodeId) {
        if self.get(id).is_some_and(|n| is_media(n) && n.plain_attr("muted").is_some()) {
            self.media_mut(id).muted = true;
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "mediaGet", media_get, context_id);
    crate::dom::register(scope, ns, "mediaSet", media_set, context_id);
    crate::dom::register(scope, ns, "mediaLoad", media_load, context_id);
    crate::dom::register(scope, ns, "mediaInvoke", media_invoke, context_id);
    crate::dom::register(scope, ns, "mediaPlay", media_play, context_id);
    crate::dom::register(scope, ns, "mediaPause", media_pause, context_id);
    crate::dom::register(scope, ns, "mediaFrame", media_frame, context_id);
    crate::dom::register(scope, ns, "mediaSourceInserted", media_source_inserted, context_id);
    crate::dom::register(scope, ns, "canPlayType", can_play_type_op, context_id);
}

// `canPlayType` (§4.8.11.3): '' for a container we cannot demux or a codec we do not decode in it; for MP4 or WebM with no
// `codecs` to say what is in it 'maybe'; 'probably' where every codec it names is one we decode there — H.264, VP9 or AV1
// in MP4, VP8, VP9 or AV1 in WebM (video.rs, av1.rs) — or an audio one the container carries (an audio track is no
// obstacle to loading the video, which is all the element does). For an audio type, what Chrome answers: audio is not
// decoded at all, but the playback state an element keeps for it does not need it to be, and a page picks the format it
// plays by the answer (Howler, Modernizr). Chrome's answers, measured — but for Ogg and Matroska (`video/ogg`,
// `audio/matroska`, …), containers we demux not at all, which Chrome answers maybe.
pub(crate) fn can_play_type(ty: &str) -> &'static str {
    // (…the type parsed as a MIME type, the engine's parser: a quoted `codecs` list whole, the first of a name kept)
    let Some(mime) = crate::mime::parse(ty) else { return "" };
    let Some((bare, plays)) = known_type(&mime.essence) else { return "" };
    // (…an empty `codecs` saying no more than none)
    let named = mime.parameters.iter().find(|(name, _)| name == "codecs").map(|(_, value)| value.as_str());
    let Some(named) = named.filter(|n| !n.trim().is_empty()) else { return bare };
    // (…an empty item in a list naming no codec we play — Chrome)
    if named.split(',').all(|c| plays(&c.trim().to_ascii_lowercase())) { "probably" } else { "" }
}
// A type's answer with no `codecs`, and the codecs it plays.
fn known_type(container: &str) -> Option<(&'static str, fn(&str) -> bool)> {
    // (…a codec named alone, or with a profile after a dot)
    fn family(c: &str, names: &[&str]) -> bool {
        names.iter().any(|n| c == *n || c.strip_prefix(n).is_some_and(|rest| rest.starts_with('.')))
    }
    fn mp4_audio(c: &str) -> bool {
        family(c, &["mp4a"]) || matches!(c, "flac" | "opus" | "mp3")
    }
    Some(match container {
        "video/mp4" => ("maybe", |c| family(c, &["avc1", "avc3", "av01", "vp09", "mp4a"]) || matches!(c, "opus" | "flac" | "mp3")),
        "video/webm" => ("maybe", |c| family(c, &["av01", "vp09"]) || matches!(c, "vp8" | "vp9" | "vp8.0" | "vp9.0" | "opus" | "vorbis")),
        "audio/mpeg" | "audio/mp3" => ("probably", |c| c == "mp3"),
        "audio/aac" | "audio/flac" => ("probably", |_| false),
        "audio/mp4" | "audio/x-m4a" => ("maybe", mp4_audio),
        "audio/ogg" => ("maybe", |c| matches!(c, "vorbis" | "opus" | "flac")),
        "audio/webm" => ("maybe", |c| matches!(c, "vorbis" | "opus")),
        "audio/wav" | "audio/x-wav" => ("maybe", |c| c == "1"),
        _ => return None,
    })
}
// __dom.canPlayType(type) -> '', 'maybe' or 'probably' (`can_play_type`).
fn can_play_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    let answer = can_play_type(&ty);
    rv.set(v8::String::new(scope, answer).map_or_else(|| v8::undefined(scope).into(), Into::into));
}

// The media state a member reads or writes, by the code the bindings name it with.
const NETWORK_STATE: u32 = 0;
const READY_STATE: u32 = 1;
const CURRENT_TIME: u32 = 2;
const DURATION: u32 = 3;
const PAUSED: u32 = 4;
const DEFAULT_PLAYBACK_RATE: u32 = 5;
const PLAYBACK_RATE: u32 = 6;
const PRESERVES_PITCH: u32 = 7;
const VOLUME: u32 = 8;
const MUTED: u32 = 9;
const VIDEO_WIDTH: u32 = 10;
const VIDEO_HEIGHT: u32 = 11;
const CURRENT_SRC: u32 = 12;
const ERROR: u32 = 13;

fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    crate::node_handle::nid_of(scope, value)
}

// __dom.mediaGet(media, member) -> what the member (`NETWORK_STATE` …) reads: a number, a boolean, the current source
// URL; for `ERROR`, the failure's number (0 for no error), which the bindings make its MediaError by.
fn media_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let code = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    if code == CURRENT_SRC {
        let src = crate::dom::dom(scope).arena.media(id).current_src.clone();
        return rv.set(v8::String::new(scope, &src).map_or_else(|| v8::undefined(scope).into(), Into::into));
    }
    let m = crate::dom::dom(scope).arena.media(id);
    match code {
        NETWORK_STATE => rv.set_uint32(u32::from(m.network)),
        READY_STATE => rv.set_uint32(u32::from(m.ready)),
        CURRENT_TIME => rv.set_double(m.current_time()),
        DURATION => rv.set_double(m.duration),
        PAUSED => rv.set_bool(!m.playing),
        DEFAULT_PLAYBACK_RATE => rv.set_double(m.default_rate),
        PLAYBACK_RATE => rv.set_double(m.rate),
        PRESERVES_PITCH => rv.set_bool(m.preserves_pitch),
        VOLUME => rv.set_double(m.volume),
        MUTED => rv.set_bool(m.muted),
        VIDEO_WIDTH => rv.set_uint32(m.video_size[0]),
        VIDEO_HEIGHT => rv.set_uint32(m.video_size[1]),
        ERROR => rv.set_uint32(if m.error == 0 { 0 } else { m.failures }),
        _ => {}
    }
}

// What `mediaSet` answers: done, or — a volume outside [0, 1] — an IndexSizeError for the bindings to throw.
const DONE: u32 = 0;
const OUT_OF_RANGE: u32 = 2;

// __dom.mediaSet(media, member, value) -> `DONE` or `OUT_OF_RANGE`: the member set — a rate, the volume (0 to 1),
// mutedness or pitch preservation, its event (`ratechange`, `volumechange`: §4.8.11.8, §4.8.11.13) queued only where
// what it reads changed; the current time — a seek, its `seeking`, `timeupdate` and `seeked` queued, where there is media
// data, else the default playback start position, which reads back (-0 as 0). A value that reads the same is not written:
// -0 for 0 reads back 0.
fn media_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(DONE);
    let Some(id) = element(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    let (number, flag) = (value.number_value(scope).unwrap_or(f64::NAN), value.boolean_value(scope));
    let m = crate::dom::dom(scope).arena.media_mut(id);
    // (…`value` written where it differs, `event` owed then)
    fn write<T: PartialEq>(slot: &mut T, value: T, event: &'static [&'static str]) -> &'static [&'static str] {
        if *slot == value {
            return &[];
        }
        *slot = value;
        event
    }
    let owed: &[&str] = match which {
        DEFAULT_PLAYBACK_RATE => write(&mut m.default_rate, number, &["ratechange"]),
        PLAYBACK_RATE => write(&mut m.rate, number, &["ratechange"]),
        PRESERVES_PITCH => {
            m.preserves_pitch = flag;
            &[]
        }
        VOLUME if !(0.0..=1.0).contains(&number) => return rv.set_uint32(OUT_OF_RANGE),
        VOLUME => write(&mut m.volume, number, &["volumechange"]),
        MUTED => write(&mut m.muted, flag, &["volumechange"]),
        CURRENT_TIME if m.ready == HAVE_NOTHING => {
            m.default_start = number + 0.0;
            &[]
        }
        CURRENT_TIME => {
            m.current_time = number + 0.0;
            &["seeking", "timeupdate", "seeked"]
        }
        _ => &[],
    };
    // (…an element made audible while it plays, by no user's activation, not allowed to play any more: the internal pause
    // steps — paused at once, its `timeupdate` and `pause` behind its `volumechange` — Chrome and Firefox, rv `ap`)
    let arena = &mut crate::dom::dom(scope).arena;
    let audible = matches!(which, VOLUME | MUTED) && !owed.is_empty();
    if audible && arena.media(id).playing && !allowed_to_play(arena, id) {
        arena.media_mut(id).playing = false;
        return queue_events(scope, id, &["volumechange", "timeupdate", "pause", ABORT_PLAY]);
    }
    if !owed.is_empty() {
        queue_events(scope, id, owed);
    }
}

// __dom.mediaLoad(media, host) — the media element load algorithm (§4.8.11.5), whichever asked — its `src` set, load()
// — `host` the steps its fetch is made by: this load the current one (what an earlier one queued superseded); an
// `abort` for a load under way or done, and, for an element that had any state, an `emptied` — a `timeupdate` too where
// its position was not at the start — fired from a task, its state forgotten (no media data, paused, at the start, no
// duration, no frame), its pending play promises rejected with an AbortError; no error; its playback rate its default
// one (Chrome and Firefox: 1 after `playbackRate = 2; load()`, rv `rate`); then the resource selection algorithm
// (`invoke_selection`).
fn media_load(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    let m = arena.media_mut(id);
    m.load += 1;
    let mut owed = Vec::new();
    if matches!(m.network, NETWORK_LOADING | NETWORK_IDLE) {
        owed.push("abort");
    }
    let had = m.network != NETWORK_EMPTY;
    if had {
        owed.push("emptied");
        // (…where `currentTime` read other than 0 — the default playback start position too, which the load keeps, as
        // Chrome: Firefox fires it, Chrome not, csim-bench img13 `m4`; HTML: "if this changed the official playback
        // position")
        if m.current_time() != 0.0 {
            owed.push("timeupdate");
        }
        m.ready = HAVE_NOTHING;
        m.playing = false;
        m.current_time = 0.0;
        m.duration = f64::NAN;
    }
    m.error = 0;
    m.rate = m.default_rate;
    m.deferred = false;
    m.play_requested = false;
    m.children = false;
    m.candidate = None;
    m.pointer = None;
    m.waiting = false;
    m.network = NETWORK_EMPTY;
    arena.media_arrived.remove(&id);
    if had {
        arena.video_frames.remove(&id);
    }
    if !owed.is_empty() {
        queue_events(scope, id, &owed);
    }
    // (…its pending play promises rejected with an AbortError at once: HTML "take pending play promises and reject")
    let el = crate::dom::node_value(scope, Some(id));
    settle_play(scope, el, ABORTED);
    invoke_selection(scope, cid, id, host);
}

// HTML's resource selection algorithm invoked on an element whose network state is EMPTY (§4.8.11.5): its first step,
// NO_SOURCE, its rest once the stable state comes (`run_select`) — none for one that has a state already (a load ran, or
// a `<source>` inserted into it invoked it).
fn invoke_selection(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, host: v8::Local<'_, v8::Function>) {
    let m = crate::dom::dom(scope).arena.media_mut(id);
    if m.network != NETWORK_EMPTY {
        return;
    }
    m.network = NETWORK_NO_SOURCE;
    m.delaying = true;
    select_soon(scope, cid, id, host, false);
}
// __dom.mediaInvoke(media, host) — `invoke_selection` for an element created with a `src` (the parser's, a clone's,
// whose attribute change steps do not run).
fn media_invoke(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    invoke_selection(scope, cid, id, host);
}
// __dom.mediaSourceInserted(parent, source, host) — HTMLSourceElement's insertion steps (`source_inserted`): the resource
// selection algorithm invoked, or its children mode's wait for a candidate over — the next one tried as the stable state
// comes.
fn media_source_inserted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(media), Some(source)) = (element(scope, args.get(0)), element(scope, args.get(1))) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let Some((_, resumed)) = crate::dom::dom(scope).arena.source_inserted(media, source) else { return };
    select_soon(scope, cid, media, host, resumed);
}
// …the rest of the algorithm awaiting the stable state (a microtask) under the current load — `resumed`, its children
// mode's search for the next candidate going on.
fn select_soon(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, host: v8::Local<'_, v8::Function>, resumed: bool) {
    let load = crate::dom::dom(scope).arena.media(id).load;
    let el = crate::dom::node_value(scope, Some(id));
    let items = [
        el,
        v8::Integer::new_from_unsigned(scope, load).into(),
        host.into(),
        v8::Integer::new(scope, cid).into(),
        v8::Boolean::new(scope, resumed).into(),
    ];
    let data = v8::Array::new_with_elements(scope, &items);
    let Some(step) = v8::Function::builder(run_select).data(data.into()).build(scope) else { return };
    crate::dom::call_host_step(scope, "queueMicrotask", &[step.into()]);
}
fn run_select(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(data) = v8::Local::<v8::Array>::try_from(args.data()) else { return };
    let [el, load, host, cid, resumed] = [0, 1, 2, 3, 4].map(|i| data.get_index(scope, i).unwrap_or_else(|| v8::undefined(scope).into()));
    let (Some(id), Ok(host)) = (element(scope, el), v8::Local::<v8::Function>::try_from(host)) else { return };
    let (load, cid) = (load.uint32_value(scope).unwrap_or(0), cid.int32_value(scope).unwrap_or(0));
    if !is_current(&crate::dom::dom(scope).arena, id, load) {
        return;
    }
    if resumed.is_true() {
        let m = crate::dom::dom(scope).arena.media_mut(id);
        m.network = NETWORK_LOADING;
        m.delaying = true;
        next_candidate(scope, cid, id, load, host);
    } else {
        select(scope, cid, id, load, host);
    }
}
// The resource selection algorithm's synchronous section, at the stable state, its mode decided then: with a `src`,
// the attribute mode — the network state LOADING, a `loadstart` queued, the URL the `src` parses to its current source,
// fetched (`fetch_selected`) — an empty `src`, or one that parses to none, failing (`Task::Failed`); else with a
// `<source>` child the children mode — LOADING, a `loadstart`, its candidates tried (`next_candidate`); else nothing to
// select, the network state EMPTY.
fn select(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, load: u32, host: v8::Local<'_, v8::Function>) {
    let Some(doc) = crate::dom::node_document(scope, id) else { return };
    let arena = crate::dom::realm(scope, cid);
    let Some(n) = arena.get(id) else { return };
    let src = n.plain_attr("src").map(str::to_owned);
    let source_child = n.children.iter().any(|&c| arena.get(c).is_some_and(|c| c.is_html_named("source")));
    if src.is_none() && !source_child {
        let m = arena.media_mut(id);
        m.network = NETWORK_EMPTY;
        m.delaying = false;
        return load_settled(scope);
    }
    let url = src.as_deref().filter(|s| !s.is_empty()).and_then(|s| arena.parse_document_url(doc, s)).map(|u| u.href().to_owned());
    let m = arena.media_mut(id);
    m.network = NETWORK_LOADING;
    m.children = src.is_none();
    queue_events(scope, id, &["loadstart"]);
    if src.is_none() {
        return next_candidate(scope, cid, id, load, host);
    }
    match url {
        Some(url) => fetch_selected(scope, cid, id, load, url, host),
        None => queue_task(scope, id, Task::Failed, None),
    }
}
// The children mode's next candidate (§4.8.11.5), in tree order from its pointer, which moves to it: one that fails at
// once — no `src`, an empty one, a `type` we cannot play (`can_play_type`, an empty one none), a `media` that does not
// match the realm's viewport, a URL that does not parse — its `error` queued at it and the next one tried; the first that
// does not, the current source, fetched (`fetch_selected`); none left, the network state NO_SOURCE, the algorithm waiting
// for a `<source>` inserted past the pointer (`source_inserted`).
fn next_candidate(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, load: u32, host: v8::Local<'_, v8::Function>) {
    let Some(doc) = crate::dom::node_document(scope, id) else { return };
    loop {
        let arena = crate::dom::realm(scope, cid);
        let (Some(n), m) = (arena.get(id), arena.media(id)) else { return };
        if m.load != load || !m.children || m.waiting {
            return;
        }
        let start = m.pointer.map_or(0, |node| n.children.iter().position(|&c| c == node).map_or(n.children.len(), |at| at + 1));
        let candidate = n.children.iter().skip(start).find_map(|&c| {
            let source = arena.get(c).filter(|c| c.is_html_named("source"))?;
            let playable = source.plain_attr("type").is_none_or(|ty| ty.is_empty() || !can_play_type(ty).is_empty());
            let src = source.plain_attr("src").filter(|src| !src.is_empty() && playable).map(str::to_owned);
            Some((c, src, source.plain_attr("media").map(str::to_owned)))
        });
        let Some((source, mut src, media)) = candidate else {
            let m = arena.media_mut(id);
            m.waiting = true;
            m.network = NETWORK_NO_SOURCE;
            m.delaying = false;
            return load_settled(scope);
        };
        if let Some(media) = media.filter(|_| src.is_some()) {
            let viewport = crate::viewport::of(scope, cid).map(|v| v as f32);
            if !crate::media_query_lists::matches(scope, cid, &media, (viewport[0], viewport[1])) {
                src = None;
            }
        }
        let arena = crate::dom::realm(scope, cid);
        let url = src.and_then(|s| arena.parse_document_url(doc, &s)).map(|u| u.href().to_owned());
        let m = arena.media_mut(id);
        m.candidate = Some(source);
        m.pointer = Some(source);
        match url {
            Some(url) => return fetch_selected(scope, cid, id, load, url, host),
            None => queue_task(scope, id, Task::SourceError, Some(source)),
        }
    }
}
// The selected resource `url`, the element's current source: fetched (`fetch_resource`), or — `preload` none, ASCII
// case-insensitively, the fetch put off until the page asks it to play, unless `autoplay` overrides it (an element that
// will play must buffer: HTML's note on `preload`) or the page asked already — the network state IDLE and a `suspend`
// queued, the fetch waiting for `mediaPlay`.
fn fetch_selected(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, load: u32, url: String, host: v8::Local<'_, v8::Function>) {
    let arena = crate::dom::realm(scope, cid);
    let deferred = !arena.media(id).play_requested
        && arena.get(id).is_some_and(|n| n.plain_attr("preload").is_some_and(|p| p.eq_ignore_ascii_case("none")) && n.plain_attr("autoplay").is_none());
    let m = arena.media_mut(id);
    m.current_src = url.clone();
    if deferred {
        m.network = NETWORK_IDLE;
        m.deferred = true;
        m.delaying = false;
        queue_events(scope, id, &["suspend"]);
        return load_settled(scope);
    }
    fetch_resource(scope, cid, id, load, url, host);
}
// …and fetched (subresource_obtain.rs `fetch_media`): in a document that is not fully active — a `createHTMLDocument`'s,
// a DOMParser's, template contents' — failing, such a document loading nothing.
fn fetch_resource(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, load: u32, url: String, host: v8::Local<'_, v8::Function>) {
    let doc = crate::dom::node_document(scope, id).filter(|&doc| crate::dom::realm(scope, cid).document_fully_active(doc));
    let (outcome, took) = match doc {
        Some(doc) => crate::subresource_obtain::fetch_media(scope, host, cid, id, doc, url, load),
        None => (crate::subresource_obtain::MediaFetched::Failed, 0.0),
    };
    fetched(scope, cid, id, load, outcome, took, host);
}
// What the fetch of the element `id`'s resource under `load` came to, while that is its current load: the resource,
// whose media data processing runs from a task (`Task::Fetched`); a failure — the attribute mode's the element's own
// (`Task::Failed`), the children mode's its candidate's, its `error` queued at it where it is the element's still, and the
// next one tried; or, a service worker's to answer, nothing yet (subresource_obtain.rs hands it here then).
pub(crate) fn fetched(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, load: u32, outcome: crate::subresource_obtain::MediaFetched, took: f64, host: v8::Local<'_, v8::Function>) {
    use crate::subresource_obtain::MediaFetched;
    if !is_current(&crate::dom::dom(scope).arena, id, load) {
        return;
    }
    match outcome {
        MediaFetched::Pending => {}
        MediaFetched::Arrived(resource) => {
            let arena = &mut crate::dom::dom(scope).arena;
            arena.media_arrived.insert(id, resource);
            let clock = arena.event_loop.clock;
            arena.media_mut(id).due = clock + took;
            queue_landing(scope, id, Task::Fetched, took);
        }
        MediaFetched::Failed => {
            let m = crate::dom::dom(scope).arena.media(id);
            if !m.children {
                return queue_landing(scope, id, Task::Failed, took);
            }
            if let Some(candidate) = m.candidate {
                queue_task(scope, id, Task::SourceError, Some(candidate));
            }
            next_candidate(scope, cid, id, load, host);
        }
    }
}

// What `mediaPlay` answers: played, or rejected — the element not allowed to play (a NotAllowedError), its resource not
// supported (a NotSupportedError).
const PLAYED: u32 = 0;
const NOT_ALLOWED: u32 = 1;
const NOT_SUPPORTED: u32 = 2;

// Whether the element `id` is allowed to play (HTML leaves it to the user agent; Chrome and Firefox agree, csim-bench
// img13 `m9`): an inaudible one — muted, or at volume 0 — or one whose document's window has sticky activation (a user
// has interacted with the page), or any, where the session allows it (`autoplay`, the driver's). What `autoplay` starts
// by too.
fn allowed_to_play(arena: &RealmArena, id: NodeId) -> bool {
    let m = arena.media(id);
    arena.autoplay || m.muted || m.volume == 0.0 || arena.get(id).is_some_and(|n| arena.sticky_activated(n.realm))
}

// __dom.mediaPlay(media, host) -> HTML's play() (§4.8.11.8), `PLAYED` or what rejects it: an element not allowed to play
// (`allowed_to_play`), one whose resource is not supported (its error MEDIA_ERR_SRC_NOT_SUPPORTED, every error this model
// has); else the internal play steps — an element whose network state is EMPTY invoking its resource selection
// algorithm, a paused element unpaused, its `play` then — with no data to play from (up to HAVE_CURRENT_DATA) —
// `waiting`, or `playing`, queued; one playing already, none — and the fetch `preload` put off, which playing triggers,
// made.
fn media_play(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(NOT_SUPPORTED) };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_uint32(NOT_SUPPORTED) };
    let cid = crate::dom::realm_id(scope, &args);
    let arena = &crate::dom::dom(scope).arena;
    if !allowed_to_play(arena, id) {
        return rv.set_uint32(NOT_ALLOWED);
    }
    if arena.media(id).error != 0 {
        return rv.set_uint32(NOT_SUPPORTED);
    }
    rv.set_uint32(PLAYED);
    invoke_selection(scope, cid, id, host);
    // (…its promise pending, the bindings', until the element is playing — `RESOLVE`, "notify about playing" — or is
    // paused or loaded again first)
    let m = crate::dom::dom(scope).arena.media_mut(id);
    let has_data = m.ready > HAVE_CURRENT_DATA;
    if !m.playing {
        m.playing = true;
        queue_events(scope, id, if has_data { &["play", "playing", RESOLVE] } else { &["play", "waiting"] });
    } else if has_data {
        queue_events(scope, id, &[RESOLVE]);
    }
    let m = crate::dom::dom(scope).arena.media_mut(id);
    m.play_requested = true;
    if std::mem::take(&mut m.deferred) {
        m.network = NETWORK_LOADING;
        let (load, url) = (m.load, m.current_src.clone());
        fetch_resource(scope, cid, id, load, url, host);
    }
}
// __dom.mediaPause(media, host) — the internal pause steps: an element whose network state is EMPTY invoking its
// resource selection algorithm first; a playing element paused, its `timeupdate` then `pause` queued, its pending play
// promises rejected with an AbortError after them; one paused already, none.
fn media_pause(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    invoke_selection(scope, cid, id, host);
    let m = crate::dom::dom(scope).arena.media_mut(id);
    if std::mem::take(&mut m.playing) {
        queue_events(scope, id, &["timeupdate", "pause", ABORT_PLAY]);
    }
}

// Whether `load` is the element `id`'s current one, no later load superseding it.
pub(crate) fn is_current(arena: &RealmArena, id: NodeId, load: u32) -> bool {
    arena.media(id).load == load
}

// What a media element task carries out (`run_task`), under the load it was queued for: events fired; the media data
// processing steps of the resource fetched — fetched whole (`progress`, the network state IDLE, `suspend`), its metadata
// (HAVE_METADATA: the duration, a video's size, the seek to the default playback start position: `durationchange`,
// `resize`, `loadedmetadata`, …), its data (HAVE_ENOUGH_DATA: `loadeddata`, `canplay`, `playing`, `canplaythrough`) — each
// queued as the one before ran, as Chrome and Firefox run a timer a `loadedmetadata` listener sets before `loadeddata`
// (csim-bench img13 `m1`); the dedicated media source failure steps; a candidate's `error`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Task {
    Events = 0,
    Fetched = 1,
    Metadata = 2,
    Data = 3,
    Failed = 4,
    SourceError = 5,
}

// A media element task of the element `id`'s current load queued, each at its own turn of the event loop — `source` the
// `<source>` a candidate's error is fired at. (The document's load waits on the element's delaying-the-load-event flag
// meanwhile, not on these: `media_delays_load`.)
fn queue_task(scope: &mut v8::PinScope<'_, '_>, id: NodeId, task: Task, source: Option<NodeId>) {
    let extra = crate::dom::node_value(scope, source);
    queue_with(scope, id, task, extra, 0.0);
}
// …the one its fetch's response lands in, `took` ms from now: as far after the fetch as its server took.
fn queue_landing(scope: &mut v8::PinScope<'_, '_>, id: NodeId, task: Task, took: f64) {
    let extra = v8::null(scope).into();
    queue_with(scope, id, task, extra, took);
}
// …the events `events`, fired in turn while the load is the element's: one a listener supersedes — setting its `src`,
// calling load() — drops the rest, as the load algorithm removes the element's queued tasks.
fn queue_events(scope: &mut v8::PinScope<'_, '_>, id: NodeId, events: &[&str]) {
    let items: Vec<v8::Local<v8::Value>> = events.iter().filter_map(|e| v8::String::new(scope, e)).map(Into::into).collect();
    let names = v8::Array::new_with_elements(scope, &items).into();
    queue_with(scope, id, Task::Events, names, 0.0);
}
fn queue_with(scope: &mut v8::PinScope<'_, '_>, id: NodeId, task: Task, extra: v8::Local<'_, v8::Value>, delay: f64) {
    let load = crate::dom::dom(scope).arena.media(id).load;
    let el = crate::dom::node_value(scope, Some(id));
    let items = [el, v8::Integer::new_from_unsigned(scope, load).into(), v8::Integer::new_from_unsigned(scope, task as u32).into(), extra];
    let data = v8::Array::new_with_elements(scope, &items);
    let Some(step) = v8::Function::builder(run_task).data(data.into()).build(scope) else { return };
    crate::timers::queue_task_in(scope, step, delay);
}
// …and the document's load asked about again, a media element delaying it no more (bridge.entry.js
// `realmHooks.loadBlockerSettled`).
fn load_settled(scope: &mut v8::PinScope<'_, '_>) {
    crate::dom::call_host_step(scope, "loadBlockerSettled", &[]);
}
impl RealmArena {
    // Whether a media element of realm `cid`'s delays its document's load (its delaying-the-load-event flag).
    pub(crate) fn media_delays_load(&self, cid: i32) -> bool {
        self.media.iter().any(|(&id, m)| m.delaying && self.get(id).is_some_and(|n| n.realm == cid))
    }
    // …and when, on the clock, the earliest of those has work due: its fetch's landing, else now (its tasks queued now).
    pub(crate) fn media_load_due(&self, cid: i32) -> Option<f64> {
        let clock = self.event_loop.clock;
        let delaying = self.media.iter().filter(|&(&id, m)| m.delaying && self.get(id).is_some_and(|n| n.realm == cid));
        delaying.map(|(_, m)| m.due.max(clock)).reduce(f64::min)
    }
}
fn run_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(data) = v8::Local::<v8::Array>::try_from(args.data()) else { return };
    let [el, load, task, extra] = [0, 1, 2, 3].map(|i| data.get_index(scope, i).unwrap_or_else(|| v8::undefined(scope).into()));
    let Some(id) = element(scope, el) else { return };
    let (load, task) = (load.uint32_value(scope).unwrap_or(0), task.uint32_value(scope).unwrap_or(u32::MAX));
    let tasks = [Task::Events, Task::Fetched, Task::Metadata, Task::Data, Task::Failed, Task::SourceError];
    let Some(task) = tasks.into_iter().find(|&t| t as u32 == task) else { return };
    let current = |scope: &mut v8::PinScope<'_, '_>| is_current(&crate::dom::dom(scope).arena, id, load);
    if !current(scope) {
        return;
    }
    let events: Vec<String> = match task {
        Task::Events => {
            let Ok(names) = v8::Local::<v8::Array>::try_from(extra) else { return };
            (0..names.length()).filter_map(|i| names.get_index(scope, i)).map(|n| n.to_rust_string_lossy(scope)).collect()
        }
        Task::SourceError => return fire(scope, extra, "error"),
        Task::Failed => {
            failure_steps(&mut crate::dom::dom(scope).arena, id);
            fire(scope, el, "error");
            settle_play(scope, el, NOT_SUPPORTED);
            return load_settled(scope);
        }
        Task::Fetched => {
            fire(scope, el, "progress");
            if !current(scope) {
                return;
            }
            crate::dom::dom(scope).arena.media_mut(id).network = NETWORK_IDLE;
            fire(scope, el, "suspend");
            if current(scope) {
                queue_task(scope, id, Task::Metadata, None);
            }
            return;
        }
        Task::Metadata => metadata_steps(&mut crate::dom::dom(scope).arena, id).iter().map(|e| (*e).to_owned()).collect(),
        Task::Data => data_steps(&mut crate::dom::dom(scope).arena, id).iter().map(|e| (*e).to_owned()).collect(),
    };
    for ty in &events {
        if !current(scope) {
            return;
        }
        match ty.as_str() {
            RESOLVE => settle_play(scope, el, PLAYED),
            ABORT_PLAY => settle_play(scope, el, ABORTED),
            _ => fire(scope, el, ty),
        }
    }
    if task == Task::Metadata && current(scope) {
        queue_task(scope, id, Task::Data, None);
    }
    if task == Task::Data {
        load_settled(scope);
    }
}
// What an event list may hold beside events: its pending play promises resolved ("notify about playing"), or rejected
// with an AbortError (paused first).
const RESOLVE: &str = "!resolve";
const ABORT_PLAY: &str = "!abort";
// …settled by the bindings (media.js `settlePlayPromises`): `PLAYED` resolved, else rejected — `ABORTED` with an
// AbortError, `NOT_SUPPORTED` with a NotSupportedError.
const ABORTED: u32 = 3;
fn settle_play(scope: &mut v8::PinScope<'_, '_>, el: v8::Local<'_, v8::Value>, how: u32) {
    let how = v8::Integer::new_from_unsigned(scope, how).into();
    crate::dom::call_host_step(scope, "settlePlayPromises", &[el, how]);
}
// (…an Event of no interface more, that does not bubble)
fn fire(scope: &mut v8::PinScope<'_, '_>, target: v8::Local<'_, v8::Value>, ty: &str) {
    let Some(ty) = v8::String::new(scope, ty) else { return };
    let no = v8::Boolean::new(scope, false).into();
    crate::dom::call_host_step(scope, "fireSimpleEvent", &[target, ty.into(), no]);
}

// What a media element's resource came to: a video's decoded (its size, duration, CORS-cross-origin taint and first
// frame), an audio's usable (not decoded: its duration its container's, `audio::duration`).
#[derive(Clone)]
pub(crate) enum MediaResource {
    Video { width: f64, height: f64, duration: f64, tainted: bool, frame: Option<crate::image_requests::Pixels> },
    Audio { duration: f64 },
}
// The dedicated media source failure steps: the error MEDIA_ERR_SRC_NOT_SUPPORTED (a failure counted, its MediaError a
// new one), the network state NO_SOURCE, no media data — no duration, no frame, no taint.
fn failure_steps(arena: &mut RealmArena, id: NodeId) {
    arena.video_frames.remove(&id);
    arena.media_arrived.remove(&id);
    let m = arena.media_mut(id);
    m.duration = f64::NAN;
    m.ready = HAVE_NOTHING;
    m.tainted = false;
    m.error = MEDIA_ERR_SRC_NOT_SUPPORTED;
    m.failures += 1;
    m.network = NETWORK_NO_SOURCE;
    m.delaying = false;
}
// The resource's metadata (§4.8.11.5 "media data processing", §4.8.11.7): its duration — a video's decoded, an audio's
// its container's — a video's size and taint, HAVE_METADATA, and the seek to the default
// playback start position: the events it owes — a `durationchange` where the duration changed and a video's `resize`
// where it has a size (before `loadedmetadata`, as Chrome and Firefox fire them, `m1`), `loadedmetadata`, then the seek's
// `seeking`, `timeupdate`, `seeked`.
fn metadata_steps(arena: &mut RealmArena, id: NodeId) -> Vec<&'static str> {
    let Some(resource) = arena.media_arrived.get(&id).cloned() else { return Vec::new() };
    let m = arena.media_mut(id);
    let had = m.duration;
    let (duration, sized) = match resource {
        MediaResource::Video { width, height, duration, tainted, .. } => {
            m.video_size = [width as u32, height as u32];
            m.tainted = tainted;
            (duration, width > 0.0 && height > 0.0)
        }
        MediaResource::Audio { duration } => (duration, false),
    };
    m.duration = duration;
    m.ready = HAVE_METADATA;
    let start = std::mem::take(&mut m.default_start);
    let seeked = start > 0.0;
    if seeked {
        m.current_time = if duration.is_finite() { start.min(duration) } else { start };
    }
    let mut events = Vec::new();
    if !same_number(had, duration) {
        events.push("durationchange");
    }
    if sized {
        events.push("resize");
    }
    events.push("loadedmetadata");
    if seeked {
        events.extend(["seeking", "timeupdate", "seeked"]);
    }
    events
}
// …and its data: HAVE_ENOUGH_DATA (nothing streams: all of it is there), a video's first frame what a canvas draws; the
// events it owes — `loadeddata`, `canplay`, then — not paused — `playing`, or where `autoplay` has it play, `play` and
// `playing` — and `canplaythrough` — the element delaying its document's load no more (after `loadeddata`, as HTML has it).
fn data_steps(arena: &mut RealmArena, id: NodeId) -> Vec<&'static str> {
    let autoplay = arena.get(id).is_some_and(|n| n.plain_attr("autoplay").is_some()) && allowed_to_play(arena, id);
    let Some(resource) = arena.media_arrived.remove(&id) else { return Vec::new() };
    let m = arena.media_mut(id);
    m.ready = HAVE_ENOUGH_DATA;
    m.delaying = false;
    let mut events = vec!["loadeddata", "canplay"];
    if m.playing {
        events.extend(["playing", RESOLVE]);
    } else if autoplay {
        m.playing = true;
        events.extend(["play", "playing", RESOLVE]);
    }
    events.push("canplaythrough");
    if let MediaResource::Video { frame: Some(frame), .. } = resource {
        arena.video_frames.insert(id, frame);
    }
    events
}

// __dom.mediaFrame(video) -> [pixels, width, height] — a view on its decoded frame's RGBA pixels, and its size — or null
// where it has none.
fn media_frame(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let arena = &crate::dom::dom(scope).arena;
    let (Some(frame), [w, h]) = (arena.video_frames.get(&id).cloned(), arena.media(id).video_size) else { return rv.set_null() };
    let items = [frame.view(scope), v8::Integer::new_from_unsigned(scope, w).into(), v8::Integer::new_from_unsigned(scope, h).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// …two numbers the same, NaN the same as NaN.
fn same_number(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

#[cfg(test)]
mod tests {
    use super::can_play_type;

    #[test]
    fn types_answer_as_the_table_says() {
        assert_eq!(can_play_type("video/mp4"), "maybe");
        assert_eq!(can_play_type(r#"video/mp4; codecs="avc1.42E01E, mp4a.40.2""#), "probably");
        assert_eq!(can_play_type("video/webm; codecs=vp8.0"), "probably");
        assert_eq!(can_play_type(r#"video/webm; codecs="vp8, theora""#), "");
        assert_eq!(can_play_type(r#"video/mp4; codecs="""#), "maybe");
        assert_eq!(can_play_type(r#"video/mp4; codecs="avc1,""#), "");
        assert_eq!(can_play_type("AUDIO/MPEG"), "probably");
        assert_eq!(can_play_type("audio/aac; codecs=mp4a"), "");
        assert_eq!(can_play_type("video/ogg"), "");
        assert_eq!(can_play_type("video"), "");
        // (…a quoted list whole, its `;` no parameter's end)
        assert_eq!(can_play_type(r#"video/mp4; codecs="avc1; mp4a""#), "");
        assert_eq!(can_play_type(r#"video/mp4; foo="a;codecs=xx"; codecs=avc1"#), "probably");
    }
}
