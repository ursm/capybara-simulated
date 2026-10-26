// A media element's state (HTML §4.8.11) — `<video>` and `<audio>` — the engine's: its network and ready states, the
// resource its load algorithm last selected, its playback position, duration and paused-ness, its rates, volume and
// mutedness, the error its last load failed with, a decoded video's size, and which load is the current one. The media
// element load algorithm and its resource selection run here as far as they change that state (`mediaLoad`,
// `mediaSelect`, `mediaResource`); the bindings fetch and decode the resource, keep the decoded frame, and fire the
// events each step owes. Kept per element in the arena (`RealmArena::media`), from its first use.

use crate::dom::{NodeId, RealmArena};

// The network states (HTMLMediaElement's constants).
const NETWORK_EMPTY: u8 = 0;
const NETWORK_IDLE: u8 = 1;
const NETWORK_LOADING: u8 = 2;
const NETWORK_NO_SOURCE: u8 = 3;
// The ready states that matter here: none, and all the data there is (nothing streams: a resource is all there as it
// loads).
const HAVE_NOTHING: u8 = 0;
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
    // Whether the current load's resource fetch waits for its trigger — `preload` none: the element's playing
    // (`mediaFetch`, `mediaResume`).
    deferred: bool,
    // Whether the current load selects among the `<source>` children — the children mode, whose candidate's failure is
    // the candidate's, not the element's (`mediaCandidateFailed`) — and its pointer: the child it follows, none before
    // the first (the child last made a candidate, or the one before a child it followed that was removed:
    // `media_child_detached`); `waiting` where every candidate failed, the algorithm awaiting a `<source>` inserted past
    // it (`source_inserted`).
    children: bool,
    pointer: Option<NodeId>,
    waiting: bool,
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
    children: false,
    pointer: None,
    waiting: false,
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
    fn media(&self, id: NodeId) -> &Media {
        self.media.get(&id).unwrap_or(&INITIAL)
    }
    fn media_mut(&mut self, id: NodeId) -> &mut Media {
        self.media.entry(id).or_default()
    }
    // A child taken out of a media element: a pointer that followed it now follows the child before it, the pointer
    // sitting between nodes (§4.8.11.5).
    pub(crate) fn media_child_detached(&mut self, media: NodeId, child: NodeId) {
        let Some(n) = self.get(media) else { return };
        if self.media(media).pointer != Some(child) {
            return;
        }
        let before = n.children.iter().position(|&c| c == child).and_then(|at| at.checked_sub(1)).map(|at| n.children[at]);
        self.media_mut(media).pointer = before;
    }
    // HTMLSourceElement's insertion steps (HTML §4.8.11.2 `source`): into a media element with no `src` whose network
    // state is EMPTY, the resource selection algorithm invoked — its first step, NO_SOURCE, its rest as the stable
    // state comes (`mediaSelect`) — `Some((load, false))`; into one whose children mode waits for a candidate, past its
    // pointer, the wait over — the network state LOADING, the next candidate tried as the stable state comes
    // (`mediaCandidate`) — `Some((load, true))`.
    pub(crate) fn source_inserted(&mut self, media: NodeId, source: NodeId) -> Option<(u32, bool)> {
        let n = self.get(media).filter(|n| is_media(n))?;
        let at = |node: NodeId| n.children.iter().position(|&c| c == node);
        let index = at(source)?;
        let m = self.media(media);
        if m.network == NETWORK_EMPTY && n.plain_attr("src").is_none() {
            let m = self.media_mut(media);
            m.network = NETWORK_NO_SOURCE;
            return Some((m.load, false));
        }
        if !m.waiting || m.pointer.and_then(at).is_some_and(|pointer| index < pointer) {
            return None;
        }
        let m = self.media_mut(media);
        m.waiting = false;
        m.network = NETWORK_LOADING;
        Some((m.load, true))
    }
}

fn is_media(n: &crate::dom::NodeData) -> bool {
    n.is_html_named("video") || n.is_html_named("audio")
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "mediaGet", media_get, context_id);
    crate::dom::register(scope, ns, "mediaSet", media_set, context_id);
    crate::dom::register(scope, ns, "mediaLoad", media_load, context_id);
    crate::dom::register(scope, ns, "mediaSelect", media_select, context_id);
    crate::dom::register(scope, ns, "mediaCandidate", media_candidate, context_id);
    crate::dom::register(scope, ns, "mediaCandidateFailed", media_candidate_failed, context_id);
    crate::dom::register(scope, ns, "mediaFetch", media_fetch, context_id);
    crate::dom::register(scope, ns, "mediaResume", media_resume, context_id);
    crate::dom::register(scope, ns, "mediaResource", media_resource, context_id);
    crate::dom::register(scope, ns, "mediaFrame", media_frame, context_id);
    crate::dom::register(scope, ns, "mediaCurrent", media_current, context_id);
    crate::dom::register(scope, ns, "mediaSourceInserted", media_source_inserted, context_id);
    crate::dom::register(scope, ns, "mediaInserted", media_inserted, context_id);
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

// __dom.mediaSourceInserted(parent, source) -> `[load, resumed]`: what a `<source>` inserted into `parent` invokes
// (`source_inserted`) — the resource selection algorithm, or (`resumed`) its children mode's wait over — or null.
fn media_source_inserted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(media), Some(source)) = (element(scope, args.get(0)), element(scope, args.get(1))) else { return rv.set_null() };
    let Some((load, resumed)) = crate::dom::dom(scope).arena.source_inserted(media, source) else { return rv.set_null() };
    let items = [v8::Integer::new_from_unsigned(scope, load).into(), v8::Boolean::new(scope, resumed).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
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
// (…not an IDL member: whether a canvas the video's frame is drawn into is tainted by it)
const TAINTED: u32 = 14;

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
        TAINTED => rv.set_bool(m.tainted),
        _ => {}
    }
}

// What `mediaSet` answers: nothing to fire; the events the change owes (`ratechange`, `volumechange`, a seek's); or, for
// a volume outside [0, 1], an IndexSizeError.
const NO_EVENT: u32 = 0;
const CHANGED: u32 = 1;
const OUT_OF_RANGE: u32 = 2;

// __dom.mediaSet(media, member, value) -> `NO_EVENT`, `CHANGED` or `OUT_OF_RANGE`: the member set — a rate, the volume
// (0 to 1), mutedness or pitch preservation, its event owed only where what it reads changed; the current time (a seek,
// `seeking`, `timeupdate` and `seeked` owed where there is media data, else the default playback start position, which
// reads back — -0 as 0); `PAUSED` false for play(), true for pause(), its events owed where it changed (the bindings
// fire them). A value that reads the same is not written: -0 for 0 reads back 0.
fn media_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(NO_EVENT) };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    let number = || value.number_value(scope).unwrap_or(f64::NAN);
    let (number, flag) = (number(), value.boolean_value(scope));
    let text = (which == CURRENT_SRC).then(|| value.to_rust_string_lossy(scope));
    let m = crate::dom::dom(scope).arena.media_mut(id);
    // (…`value` written where it differs, its event owed then)
    fn write<T: PartialEq>(slot: &mut T, value: T) -> u32 {
        if *slot == value {
            return NO_EVENT;
        }
        *slot = value;
        CHANGED
    }
    rv.set_uint32(match which {
        DEFAULT_PLAYBACK_RATE => write(&mut m.default_rate, number),
        PLAYBACK_RATE => write(&mut m.rate, number),
        PRESERVES_PITCH => {
            m.preserves_pitch = flag;
            NO_EVENT
        }
        VOLUME if !(0.0..=1.0).contains(&number) => OUT_OF_RANGE,
        VOLUME => write(&mut m.volume, number),
        MUTED => write(&mut m.muted, flag),
        CURRENT_TIME if m.ready == HAVE_NOTHING => {
            m.default_start = number + 0.0;
            NO_EVENT
        }
        CURRENT_TIME => {
            m.current_time = number + 0.0;
            CHANGED
        }
        PAUSED => write(&mut m.playing, !flag),
        CURRENT_SRC => {
            m.current_src = text.unwrap_or_default();
            NO_EVENT
        }
        _ => NO_EVENT,
    });
}

// What the media element load algorithm owes as it begins: an `abort` (a load under way, or done), an `emptied` (the
// element had any state, now forgotten), a `timeupdate` (its playback position was not at the start).
const ABORT: u32 = 1;
const EMPTIED: u32 = 1 << 1;
const TIMEUPDATE: u32 = 1 << 2;

// __dom.mediaLoad(media) -> `[load, owed]`: the media element load algorithm (§4.8.11.5), whichever asked — its `src`
// set, load() — as far as it changes the element's state: this load the current one (what an earlier one queued
// superseded), and, for an element that had any state, no media data, paused, at the start, no duration; no error; then
// the resource selection algorithm's first step, NO_SOURCE, its rest once the script that asked has run (`mediaSelect`).
// `owed` the events it owes (`ABORT` …).
fn media_load(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let m = crate::dom::dom(scope).arena.media_mut(id);
    m.load += 1;
    let mut owed = 0;
    if matches!(m.network, NETWORK_LOADING | NETWORK_IDLE) {
        owed |= ABORT;
    }
    if m.network != NETWORK_EMPTY {
        owed |= EMPTIED;
        // (…where `currentTime` read other than 0 — the default playback start position too, which the load keeps, as
        // Chrome)
        if m.current_time() != 0.0 {
            owed |= TIMEUPDATE;
        }
        m.ready = HAVE_NOTHING;
        m.playing = false;
        m.current_time = 0.0;
        m.duration = f64::NAN;
    }
    m.error = 0;
    m.deferred = false;
    m.children = false;
    m.pointer = None;
    m.waiting = false;
    m.network = NETWORK_NO_SOURCE;
    let load = m.load;
    rv.set(v8::Array::new_with_elements(scope, &[v8::Integer::new_from_unsigned(scope, load).into(), v8::Integer::new_from_unsigned(scope, owed).into()]).into());
}

// __dom.mediaInserted(media) -> the media element's insertion into a document (HTML §4.8.11.5): one whose network state
// is EMPTY invokes the resource selection algorithm — its first step, NO_SOURCE, its rest once the stable state comes
// (`mediaSelect`) — under its current load, which this returns; null for one that has a state already (a load ran: its
// `src` set before it was inserted, or a `<source>` inserted into it).
fn media_inserted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let m = crate::dom::dom(scope).arena.media_mut(id);
    if m.network != NETWORK_EMPTY {
        return rv.set_null();
    }
    m.network = NETWORK_NO_SOURCE;
    rv.set_uint32(m.load);
}

// __dom.mediaCurrent(media, load) -> whether `load` is still the element's current load.
fn media_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    rv.set_bool(crate::dom::dom(scope).arena.media(id).load == load);
}

// __dom.mediaSelect(media, load) -> what the resource selection algorithm does as the stable state comes, its mode
// decided then: with a `src`, that — the attribute mode: the network state LOADING, its `loadstart` owed and the
// resource fetched; else with a `<source>` child, true — the children mode: the network state LOADING, its `loadstart`
// owed and its candidates tried (`mediaCandidate`); else null — nothing to select, the network state EMPTY. Null too
// where a later load superseded `load`.
fn media_select(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(n) = arena.get(id) else { return rv.set_null() };
    let src = n.plain_attr_units("src");
    let source_child = n.children.iter().any(|&c| arena.get(c).is_some_and(|c| c.is_html_named("source")));
    let m = arena.media_mut(id);
    if m.load != load {
        return rv.set_null();
    }
    match src {
        Some(src) => {
            m.network = NETWORK_LOADING;
            rv.set(crate::dom::utf16_value(scope, &src));
        }
        None if source_child => {
            m.network = NETWORK_LOADING;
            m.children = true;
            rv.set_bool(true);
        }
        None => {
            m.network = NETWORK_EMPTY;
            rv.set_null();
        }
    }
}

// __dom.mediaCandidate(media, load) -> `[source, src]`: the children mode's next candidate (§4.8.11.5), the `<source>`
// child past its pointer, which it moves to it — `src` null where it fails at once (no `src`, an empty one, or a `type`
// we cannot play: `can_play_type`), its `error` owed and the next one tried; else none left — null, the network state
// NO_SOURCE, the algorithm waiting for a `<source>` inserted past the pointer. Null too where a later load superseded
// `load`.
fn media_candidate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    let arena = &mut crate::dom::dom(scope).arena;
    let (Some(n), m) = (arena.get(id), arena.media(id)) else { return rv.set_null() };
    if m.load != load || !m.children || m.waiting {
        return rv.set_null();
    }
    let start = m.pointer.map_or(0, |node| n.children.iter().position(|&c| c == node).map_or(n.children.len(), |at| at + 1));
    let candidate = n.children.iter().skip(start).find_map(|&c| {
        let source = arena.get(c).filter(|c| c.is_html_named("source"))?;
        let playable = source.plain_attr("type").is_none_or(|ty| !can_play_type(ty).is_empty());
        Some((c, source.plain_attr_units("src").filter(|src| !src.is_empty() && playable)))
    });
    let m = arena.media_mut(id);
    let Some((source, src)) = candidate else {
        m.waiting = true;
        m.network = NETWORK_NO_SOURCE;
        return rv.set_null();
    };
    m.pointer = Some(source);
    let src = match src {
        Some(src) => crate::dom::utf16_value(scope, &src),
        None => v8::null(scope).into(),
    };
    let source = crate::dom::node_value(scope, Some(source));
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &[source, src]).into());
}

// __dom.mediaCandidateFailed(media) -> the candidate whose fetch failed, the children mode's — its `error` owed, the next
// one tried — or null for the attribute mode's, the element's own failure (`mediaResource`).
fn media_candidate_failed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let m = crate::dom::dom(scope).arena.media(id);
    let source = m.pointer.filter(|_| m.children);
    rv.set(crate::dom::node_value(scope, source));
}

// __dom.mediaFetch(media) -> whether the resource fetch algorithm (§4.8.11.5) fetches the selected resource now: not
// where `preload` says `none` (ASCII case-insensitively) — the fetch the algorithm may put off until the user asks for
// playback — unless `autoplay` overrides it (an element that will play must buffer: HTML's note on `preload`); the
// network state IDLE then, its `suspend` owed, the fetch waiting for `mediaResume`.
fn media_fetch(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    let arena = &mut crate::dom::dom(scope).arena;
    let deferred = arena.get(id).is_some_and(|n| {
        n.plain_attr("preload").is_some_and(|p| p.eq_ignore_ascii_case("none")) && n.plain_attr("autoplay").is_none()
    });
    if deferred {
        let m = arena.media_mut(id);
        m.network = NETWORK_IDLE;
        m.deferred = true;
    }
    rv.set_bool(!deferred);
}

// __dom.mediaResume(media) -> the load whose put-off fetch the element's playing triggers — the network state LOADING
// again, the fetch to run — or null where none waits.
fn media_resume(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let m = crate::dom::dom(scope).arena.media_mut(id);
    if !std::mem::take(&mut m.deferred) {
        return rv.set_null();
    }
    m.network = NETWORK_LOADING;
    rv.set_uint32(m.load);
}

// What the bindings' fetch of the selected resource came to (`mediaResource`): it failed — an empty `src`, a resource
// that could not be fetched or that cannot be played; a video decoded; an audio usable (not decoded: its readiness
// alone).
const RESOURCE_FAILED: u32 = 0;
const VIDEO_DECODED: u32 = 1;
const AUDIO_USABLE: u32 = 2;

// __dom.mediaResource(media, outcome, width, height, duration, tainted, frame): the resource's outcome — a failure the
// dedicated media source failure steps (MEDIA_ERR_SRC_NOT_SUPPORTED, no media data, NO_SOURCE: an earlier resource no
// longer there, its frame and the frame's taint with it); a decoded video all its data (HAVE_ENOUGH_DATA), its size,
// duration, taint and frame (`frame`, its RGBA pixels: a Uint8ClampedArray), IDLE — a seek to the default playback
// start position where that is past 0 (within the duration), which then is 0 whatever it was; a usable audio IDLE. ->
// the events the media data processing steps owe, in order (`resource_events`): none for a failure.
fn media_resource(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let outcome = args.get(1).uint32_value(scope).unwrap_or(RESOURCE_FAILED);
    let [w, h, duration] = [2, 3, 4].map(|k| args.get(k).number_value(scope).unwrap_or(f64::NAN));
    let tainted = args.get(5).boolean_value(scope);
    let frame = (outcome == VIDEO_DECODED).then(|| crate::image_requests::Pixels::of(scope, args.get(6))).flatten();
    let autoplay = crate::dom::dom(scope).arena.get(id).is_some_and(|n| n.plain_attr("autoplay").is_some());
    let arena = &mut crate::dom::dom(scope).arena;
    match frame {
        Some(frame) => arena.video_frames.insert(id, frame),
        None => arena.video_frames.remove(&id),
    };
    let m = arena.media_mut(id);
    let events = match outcome {
        VIDEO_DECODED => {
            let had_duration = m.duration;
            m.video_size = [w as u32, h as u32];
            m.tainted = tainted;
            m.duration = duration;
            m.ready = HAVE_ENOUGH_DATA;
            m.network = NETWORK_IDLE;
            let start = std::mem::take(&mut m.default_start);
            let seeked = start > 0.0;
            if seeked {
                m.current_time = if duration.is_finite() { start.min(duration) } else { start };
            }
            let playing = if m.playing {
                Playing::Already
            } else if autoplay {
                m.playing = true;
                Playing::Autoplayed
            } else {
                Playing::Paused
            };
            resource_events(!same_number(had_duration, duration), w > 0.0 && h > 0.0, seeked, playing)
        }
        // (…an audio's resource is not decoded: it stays HAVE_NOTHING, its events the ladder all the same)
        AUDIO_USABLE => {
            m.network = NETWORK_IDLE;
            resource_events(false, false, false, if m.playing { Playing::Already } else { Playing::Paused })
        }
        _ => {
            m.duration = f64::NAN;
            m.ready = HAVE_NOTHING;
            m.tainted = false;
            m.error = MEDIA_ERR_SRC_NOT_SUPPORTED;
            m.failures += 1;
            m.network = NETWORK_NO_SOURCE;
            Vec::new()
        }
    };
    let items: Vec<v8::Local<v8::Value>> = events.iter().filter_map(|e| v8::String::new(scope, e)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
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
// Whether a media element whose resource is loaded plays: it is paused; it was not (`play()` before its data came); or
// `autoplay` has it play.
enum Playing {
    Paused,
    Already,
    Autoplayed,
}

// The events a media element's resource owes as it is loaded (HTML §4.8.11.5, the media data processing steps, and
// §4.8.11.7's ready states): a `durationchange` where the duration changed and a video's `resize` where it has a size
// (both before the ready state reaches HAVE_METADATA, as Chrome 155 fires them), then `loadedmetadata`; the seek to the
// default playback start position (`seeking`, `timeupdate`, `seeked`); `loadeddata` (HAVE_CURRENT_DATA), `canplay`
// (HAVE_FUTURE_DATA) and — not paused — `playing`, or where `autoplay` has it play, `play` and `playing`; and finally
// `canplaythrough` (HAVE_ENOUGH_DATA).
fn resource_events(duration_changed: bool, sized: bool, seeked: bool, playing: Playing) -> Vec<&'static str> {
    let mut events = Vec::new();
    if duration_changed {
        events.push("durationchange");
    }
    if sized {
        events.push("resize");
    }
    events.push("loadedmetadata");
    if seeked {
        events.extend(["seeking", "timeupdate", "seeked"]);
    }
    events.extend(["loadeddata", "canplay"]);
    match playing {
        Playing::Paused => {}
        Playing::Already => events.push("playing"),
        Playing::Autoplayed => events.extend(["play", "playing"]),
    }
    events.push("canplaythrough");
    events
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
