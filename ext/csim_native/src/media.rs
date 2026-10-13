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
    current_time: f64,
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
    // Which load is the current one: a later load supersedes what an earlier one had queued.
    load: u32,
}

impl Default for Media {
    fn default() -> Media {
        Media {
            network: NETWORK_EMPTY,
            ready: HAVE_NOTHING,
            current_src: String::new(),
            current_time: 0.0,
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
            load: 0,
        }
    }
}

impl RealmArena {
    fn media(&self, id: NodeId) -> Media {
        self.media.get(&id).cloned().unwrap_or_default()
    }
    fn media_mut(&mut self, id: NodeId) -> &mut Media {
        self.media.entry(id).or_default()
    }
    // HTMLSourceElement's insertion steps into a media element whose network state is empty: the resource selection
    // algorithm's first step, NO_SOURCE (the load it then queues is not modelled — that is the stable observable).
    pub(crate) fn source_inserted(&mut self, media: NodeId) {
        if self.get(media).is_some_and(is_media) && self.media(media).network == NETWORK_EMPTY {
            self.media_mut(media).network = NETWORK_NO_SOURCE;
        }
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
    crate::dom::register(scope, ns, "mediaResource", media_resource, context_id);
    crate::dom::register(scope, ns, "mediaCurrent", media_current, context_id);
    crate::dom::register(scope, ns, "mediaSourceInserted", media_source_inserted, context_id);
}

// __dom.mediaSourceInserted(parent) — a `<source>` inserted into `parent` (`source_inserted`).
fn media_source_inserted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(id) = element(scope, args.get(0)) {
        crate::dom::dom(scope).arena.source_inserted(id);
    }
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
    let m = crate::dom::dom(scope).arena.media(id);
    match args.get(1).uint32_value(scope).unwrap_or(u32::MAX) {
        NETWORK_STATE => rv.set_uint32(u32::from(m.network)),
        READY_STATE => rv.set_uint32(u32::from(m.ready)),
        CURRENT_TIME => rv.set_double(m.current_time),
        DURATION => rv.set_double(m.duration),
        PAUSED => rv.set_bool(!m.playing),
        DEFAULT_PLAYBACK_RATE => rv.set_double(m.default_rate),
        PLAYBACK_RATE => rv.set_double(m.rate),
        PRESERVES_PITCH => rv.set_bool(m.preserves_pitch),
        VOLUME => rv.set_double(m.volume),
        MUTED => rv.set_bool(m.muted),
        VIDEO_WIDTH => rv.set_uint32(m.video_size[0]),
        VIDEO_HEIGHT => rv.set_uint32(m.video_size[1]),
        CURRENT_SRC => rv.set(v8::String::new(scope, &m.current_src).map_or_else(|| v8::undefined(scope).into(), Into::into)),
        ERROR => rv.set_uint32(if m.error == 0 { 0 } else { m.failures }),
        _ => {}
    }
}

// What `mediaSet` answers: nothing to fire; the event the change owes (`ratechange`, `volumechange`, `seeked`, `play`,
// `pause`); or, for a volume outside [0, 1], an IndexSizeError.
const NO_EVENT: u32 = 0;
const CHANGED: u32 = 1;
const OUT_OF_RANGE: u32 = 2;

// __dom.mediaSet(media, member, value) -> `NO_EVENT`, `CHANGED` or `OUT_OF_RANGE`: the member set — a rate, the volume
// (0 to 1), mutedness or pitch preservation, its event owed only where what it reads changed; the current time (a seek,
// `seeked` owed where there is media data, else only the default playback start position, which reads back); `PAUSED`
// false for play(), true for pause(), each its event owed.
fn media_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_uint32(NO_EVENT) };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2);
    let number = || value.number_value(scope).unwrap_or(f64::NAN);
    let (number, flag) = (number(), value.boolean_value(scope));
    let text = (which == CURRENT_SRC).then(|| value.to_rust_string_lossy(scope));
    let m = crate::dom::dom(scope).arena.media_mut(id);
    let changed = |was: bool| if was { CHANGED } else { NO_EVENT };
    rv.set_uint32(match which {
        DEFAULT_PLAYBACK_RATE => changed(std::mem::replace(&mut m.default_rate, number) != number),
        PLAYBACK_RATE => changed(std::mem::replace(&mut m.rate, number) != number),
        PRESERVES_PITCH => {
            m.preserves_pitch = flag;
            NO_EVENT
        }
        VOLUME if !(0.0..=1.0).contains(&number) => OUT_OF_RANGE,
        VOLUME => changed(std::mem::replace(&mut m.volume, number) != number),
        MUTED => changed(std::mem::replace(&mut m.muted, flag) != flag),
        CURRENT_TIME => {
            m.current_time = number;
            changed(m.ready != HAVE_NOTHING)
        }
        PAUSED => {
            m.playing = !flag;
            CHANGED
        }
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
// …and whether the resource selection then runs: there is a `src` to select.
const SELECTS: u32 = 1 << 3;

// __dom.mediaLoad(media) -> `[load, owed]`: the media element load algorithm (§4.8.11.5), whichever asked — its `src`
// set, load() — as far as it changes the element's state: this load the current one (what an earlier one queued
// superseded), and, for an element that had any state, no media data, paused, at the start, no duration; no error. With
// no `src` there is nothing to select — the network state empty, or NO_SOURCE where a `<source>` child is (whose
// resource is not modelled); with one, NO_SOURCE until the resource selection runs, once the script that asked has
// (`mediaSelect`). `owed` the events it owes (`ABORT` …) and whether it selects (`SELECTS`).
fn media_load(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(n) = arena.get(id) else { return };
    let src = n.plain_attr("src").is_some();
    let source_child = n.children.iter().any(|&c| arena.get(c).is_some_and(|c| c.is_html_named("source")));
    let m = arena.media_mut(id);
    m.load += 1;
    let mut owed = 0;
    if matches!(m.network, NETWORK_LOADING | NETWORK_IDLE) {
        owed |= ABORT;
    }
    if m.network != NETWORK_EMPTY {
        owed |= EMPTIED;
        if m.current_time != 0.0 {
            owed |= TIMEUPDATE;
        }
        m.ready = HAVE_NOTHING;
        m.playing = false;
        m.current_time = 0.0;
        m.duration = f64::NAN;
    }
    m.error = 0;
    m.network = match (src, source_child) {
        (true, _) => {
            owed |= SELECTS;
            NETWORK_NO_SOURCE
        }
        (false, true) => NETWORK_NO_SOURCE,
        (false, false) => NETWORK_EMPTY,
    };
    let load = m.load;
    rv.set(v8::Array::new_with_elements(scope, &[v8::Integer::new_from_unsigned(scope, load).into(), v8::Integer::new_from_unsigned(scope, owed).into()]).into());
}

// __dom.mediaCurrent(media, load) -> whether `load` is still the element's current load.
fn media_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    rv.set_bool(crate::dom::dom(scope).arena.media(id).load == load);
}

// __dom.mediaSelect(media, load) -> the `src` the resource selection algorithm fetches, as it begins — the network state
// LOADING, its `loadstart` owed — or null where a later load superseded `load`, or where the element has no `src` as it
// runs (the network state then EMPTY: nothing to select).
fn media_select(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return rv.set_null() };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    let arena = &mut crate::dom::dom(scope).arena;
    let src = arena.get(id).and_then(|n| n.plain_attr_units("src"));
    let m = arena.media_mut(id);
    if m.load != load {
        return rv.set_null();
    }
    let Some(src) = src else {
        m.network = NETWORK_EMPTY;
        return rv.set_null();
    };
    m.network = NETWORK_LOADING;
    rv.set(crate::dom::utf16_value(scope, &src));
}

// What the bindings' fetch of the selected resource came to (`mediaResource`): it failed — an empty `src`, a resource
// that could not be fetched or that cannot be played; a video decoded; an audio usable (not decoded: its readiness
// alone).
const FAILED: u32 = 0;
const VIDEO: u32 = 1;
const AUDIO: u32 = 2;

// __dom.mediaResource(media, outcome, width, height, duration): the resource's outcome — a failure the dedicated media
// source failure steps (MEDIA_ERR_SRC_NOT_SUPPORTED, no media data, NO_SOURCE: an earlier resource no longer there);
// a decoded video all its data (HAVE_ENOUGH_DATA), its size and duration, IDLE; a usable audio IDLE.
fn media_resource(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = element(scope, args.get(0)) else { return };
    let outcome = args.get(1).uint32_value(scope).unwrap_or(FAILED);
    let [w, h, duration] = [2, 3, 4].map(|k| args.get(k).number_value(scope).unwrap_or(f64::NAN));
    let m = crate::dom::dom(scope).arena.media_mut(id);
    match outcome {
        VIDEO => {
            m.video_size = [w as u32, h as u32];
            m.duration = duration;
            m.ready = HAVE_ENOUGH_DATA;
            m.network = NETWORK_IDLE;
        }
        AUDIO => m.network = NETWORK_IDLE,
        _ => {
            m.duration = f64::NAN;
            m.ready = HAVE_NOTHING;
            m.error = MEDIA_ERR_SRC_NOT_SUPPORTED;
            m.failures += 1;
            m.network = NETWORK_NO_SOURCE;
        }
    }
}
