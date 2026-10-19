// HTMLMediaElement (HTML §4.8.11) — `<video>` and `<audio>`. A video's resource decodes natively
// (`__dom.decodeVideo`, video.rs) to its dimensions, duration and first RGBA frame: first-frame thumbnail
// extraction for uppy-style upload chains (Discourse's composer-video-thumbnail-uppy), the cached frame drawn
// by `drawImage(video, …)` like any ImageBitmap. Audio is not decoded; an `<audio>` has the playback state
// only (Mastodon's sounds: `new Audio()`, play / pause / currentTime / volume).

import { latin1ToBytes } from './bytes.js';
import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { resolveBlobBytes }              from './blob.js';
import { processDataUrl }                from './data-url.js';
import { resolvedPromise } from './webidl.js';
import { buildSwRequest } from './sw-client.js';
import { isHtml } from './constants.js';
import { resolveURLValue } from './base-url.js';
import { defineMediaError, defineTimeRanges } from './generated/bindings.js';
import { DOMException } from './dom-exception.js';

const isVideo = (node) => isHtml(node, 'video');
const isMedia = (node) => isVideo(node) || isHtml(node, 'audio');
// A media element's state, the engine's (media.rs): what a member reads or writes, by the code the engine names it with.
const NETWORK_STATE = 0, READY_STATE = 1, CURRENT_TIME = 2, DURATION = 3, PAUSED = 4, DEFAULT_PLAYBACK_RATE = 5;
const PLAYBACK_RATE = 6, PRESERVES_PITCH = 7, VOLUME = 8, MUTED = 9, VIDEO_WIDTH = 10, VIDEO_HEIGHT = 11, CURRENT_SRC = 12;
const ERROR = 13;
// …and, not an IDL member, whether a canvas the video's frame is drawn into is tainted by it.
const TAINTED = 14;
// …and the ready state that has data for the current position and none past it (§4.8.11.7).
const HAVE_CURRENT_DATA = 2;
// …what a write owes (`mediaSet`): its event, or — a volume out of range — an IndexSizeError.
const CHANGED = 1, OUT_OF_RANGE = 2;
// …and what the load algorithm owes as it begins (`mediaLoad`).
const ABORT = 1, EMPTIED = 2, TIMEUPDATE = 4;
// …and what the fetch of the selected resource came to (`mediaResource`).
const RESOURCE_FAILED = 0, VIDEO_DECODED = 1, AUDIO_USABLE = 2;
const mediaGet = (el, member) => globalThis.__dom.mediaGet(el, member);
const mediaSet = (el, member, value) => globalThis.__dom.mediaSet(el, member, value);

// Whether drawing `node` taints a canvas: a <video> whose frame came from an opaque response (fetchAndDecode).
export const videoTainted = (node) => isVideo(node) && mediaGet(node, TAINTED);

// HTMLSourceElement insertion step — the synchronous head of the media resource
// selection algorithm, the engine's (media.rs `source_inserted`): inserting a
// <source> into a media element whose networkState is NETWORK_EMPTY makes it
// NETWORK_NO_SOURCE. Run as an INSERTION step (during parenting / connect), so it
// lands BEFORE an earlier-inserted script's post-insertion execution
// (Node-appendChild-script-and-source-from-fragment).
export function runSourceInsertionStep(child, parent) {
  if (child && isHtml(child, 'source') && parent) globalThis.__dom.mediaSourceInserted(parent);
}

// Resolve a media `src` to its bytes (a Uint8Array) for the decoder. A `blob:`
// URL reads the in-VM blob store, then the host registry; a `data:` URL decodes its
// payload; anything else (http / relative) is fetched on the Ruby side. Returns null when
// the source can't be resolved.
function videoBytes(src) {
  if (!src) return null;
  if (src.startsWith('blob:')) {
    // (…as a fetch resolves one: the host registry's word on whether it is live first, a revoke anywhere included)
    const r = resolveBlobBytes(src);
    return r ? latin1ToBytes(r.bytes) : null;
  }
  if (src.startsWith('data:')) {
    const parsed = processDataUrl(src);
    return parsed ? latin1ToBytes(parsed.body) : null;
  }
  const r = typeof globalThis.__csim_videoBytes === 'function' ? globalThis.__csim_videoBytes(src) : null;
  return r ? r.bytes : null;
}

// A failed load/decode discards the PREVIOUS resource: the old frame must not
// stay drawable (its taint verdict no longer applies), matching the media load
// algorithm's dedicated media source failure steps — which set `error` to a
// MEDIA_ERR_SRC_NOT_SUPPORTED MediaError: an empty `src`, a resource that could not
// be fetched, or one we cannot play (audio at all; a codec we do not decode — HEVC,
// Theora — or a corrupt file).
function failLoad(media) {
  media._csimVideoFrame = null;
  globalThis.__dom.mediaResource(media, RESOURCE_FAILED);
  globalThis.__csimQueueMicrotask(() => dispatchMediaEvent(media, 'error'));
}

// The media element load algorithm (§4.8.11.5), whichever asked — its `src` set, load() — the engine's as far as it
// changes the element's state (media.rs `mediaLoad`): what a load under way had queued dropped; an `abort` for one under
// way or done, and for an element that had any state an `emptied` (a `timeupdate` where it was not at the start); then
// the resource selection algorithm, once the script that asked has run (a stable state) — none where a later load has
// superseded it (`mediaSelect`): with a `src`, `loadstart` and the resource fetched — an empty `src` failing; with a
// `<source>` child, `loadstart` alone (its resource is not modelled); else nothing.
function loadMedia(media) {
  const [load, owed] = globalThis.__dom.mediaLoad(media);
  const queue = (type) => globalThis.__csimQueueMicrotask(() => { if (globalThis.__dom.mediaCurrent(media, load)) dispatchMediaEvent(media, type); });
  if (owed & ABORT) queue('abort');
  if (owed & EMPTIED) queue('emptied');
  if (owed & TIMEUPDATE) queue('timeupdate');
  globalThis.__csimQueueMicrotask(() => {
    const src = globalThis.__dom.mediaSelect(media, load);
    if (src === null) return;
    dispatchMediaEvent(media, 'loadstart');
    if (src === true) return;
    if (src === '') { failLoad(media); return; }
    const abs = absoluteURL(media, src);
    mediaSet(media, CURRENT_SRC, abs);
    if (isVideo(media)) fetchAndDecode(media, abs, load);
    else fetchAudio(media, abs, load);
  });
}

// MediaError (HTML §4.8.11.1), generated from its IDL: why a media element's resource failed — its code and message, in
// its slots. Made by the platform alone, one for each failure the engine counts (`mediaGet(…, ERROR)`), kept per element.
const mediaErrorBinding = defineMediaError({
  init(s, code, message) { s.code = code; s.message = message; },
  get_code: (s) => s.code,
  get_message: (s) => s.message
});
const MediaError = mediaErrorBinding.interface;
const mediaErrors = new WeakMap();
function errorOf(el) {
  const failure = mediaGet(el, ERROR);
  if (failure === 0) return null;
  const kept = mediaErrors.get(el);
  if (kept && kept.failure === failure) return kept.error;
  const error = mediaErrorBinding.create(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, 'The media resource could not be loaded or decoded.');
  mediaErrors.set(el, { failure, error });
  return error;
}
globalThis.MediaError = MediaError;

// TimeRanges (HTML §4.8.11.6), generated from its IDL: the ranges of the media timeline a media element has buffered,
// can seek to, or has played — a list of [start, end] pairs in its slots. Made by the platform alone.
const timeRangesBinding = defineTimeRanges({
  init(s, ranges) { s.ranges = ranges; },
  get_length: (s) => s.ranges.length,
  start: (s, index) => rangeAt(s, index, 'start')[0],
  end: (s, index) => rangeAt(s, index, 'end')[1]
});
function rangeAt(s, index, method) {
  if (index >= s.ranges.length) {
    throw new DOMException(
      `Failed to execute '${method}' on 'TimeRanges': The index provided (${index}) is greater than or equal to the maximum bound (${s.ranges.length}).`,
      'IndexSizeError');
  }
  return s.ranges[index];
}
globalThis.TimeRanges = timeRangesBinding.interface;
// (…the whole of a decoded resource's timeline, none before there is one: nothing streams, so a resource is all there
// as it loads)
function wholeTimeline(el) {
  const duration = mediaGet(el, DURATION);
  return timeRangesBinding.create(Number.isFinite(duration) ? [[0, duration]] : []);
}

// (…the `src` resolved against the element's base URL, as the resource selection algorithm takes it — as it is where it
// does not parse)
function absoluteURL(el, src) {
  return resolveURLValue(el, src) ?? src;
}

// A video's resource fetched and decoded — `abs` its `src` resolved against its base (not the main document's: the
// recurring wrong-base class) — a CONTROLLED document's bytes through its service worker (destination 'video') before
// the plain host fetch.
function fetchAndDecode(video, abs, load) {
  let bytes = null;
  // The taint verdict travels WITH the bytes and is committed only alongside the
  // decoded frame below — a failed load/decode must never pair the previous
  // frame with a new verdict (the <img> path's "state changes only at commit").
  let tainted = false;
  // `crossorigin` maps exactly like the <img>/<audio> paths (_imageCorsRequest).
  const {cors, mode, credentials} = video._imageCorsRequest();
  if (/^https?:/i.test(abs) && typeof globalThis.__csimSwFetchDest === 'function') {
    const sw = globalThis.__csimSwFetchDest(abs, 'video', mode, credentials, true);
    if (sw && sw.blocked) { failLoad(video); return; }
    if (sw) {
      // An intercepted response with an EMPTY body is a failed media decode —
      // never fall through to the network for bytes the SW already answered.
      if (sw.bytes == null || sw.bytes.length === 0) { failLoad(video); return; }
      bytes = sw.bytes;
      // Canvas origin-clean: an OPAQUE (no-cors cross-origin-derived) response's
      // frames taint a canvas they're drawn into; a cors/basic one is clean.
      tainted = sw.type === 'opaque';
    }
  }
  if (bytes == null) {
    if (/^https?:/i.test(abs)) {
      // The network leg runs the same CORS/taint verdict as the <img> host loader:
      // {bytes, tainted}, or null for a failed load (incl. a cors-mode ACAO refusal).
      const r = typeof globalThis.__csim_videoBytes === 'function'
        ? globalThis.__csim_videoBytes(abs, cors, credentials, (globalThis.location && globalThis.location.href) || '')
        : null;
      if (r) { bytes = r.bytes; tainted = !!r.tainted; }
    } else {
      bytes = videoBytes(abs);   // blob:/data: — same-origin-ish, never taints
    }
  }
  if (!bytes) { failLoad(video); return; }
  const decoded = globalThis.__dom.decodeVideo(bytes);
  if (!decoded) { failLoad(video); return; }
  video._csimVideoFrame = {width: decoded.width, height: decoded.height, _pixels: decoded.pixels};
  // (…the events the media data processing steps owe — the engine's (media.rs `resource_events`): its duration and size,
  // its metadata, a seek to the default playback start position, its data and — playing, as `autoplay` has it begin,
  // which the canvas-tainting helper draws on — `play` and `playing`)
  const events = globalThis.__dom.mediaResource(video, VIDEO_DECODED, decoded.width, decoded.height, decoded.duration, tainted);
  globalThis.__csimQueueMicrotask(() => dispatchResourceEvents(video, load, events));
}
// …each while the load that owes it is the element's: one a listener supersedes — setting its `src`, calling load() —
// drops the rest, as the load algorithm removes the element's queued tasks.
function dispatchResourceEvents(media, load, events) {
  for (const type of events) {
    if (!globalThis.__dom.mediaCurrent(media, load)) return;
    dispatchMediaEvent(media, type);
  }
}

function dispatchMediaEvent(media, type) {
  fireEvent(media, new Event(type));
}

// A media element's `src` attribute set or changed (HTML §4.8.11.2) — by any route, to the value it had too — invokes
// its load algorithm; its removal does not. Not yet for an element the parser creates with its `src` (attribute change
// steps do not run there).
export function mediaSrcChanged(el) {
  if (isMedia(el)) loadMedia(el);
}
// An audio's resource is not decoded, but in a CONTROLLED document it fetches through the service worker (destination
// audio — the fetch IS the observable; fetch-destination asserts it), and a usable response fires the readiness ladder
// to canplaythrough, a refused one fails the load. An UNCONTROLLED document fetches no audio — playback is not modelled,
// and fetching every app's <audio src> would be pure cost (rule 3) — so its load stays under way.
function fetchAudio(audio, abs, load) {
  const ctrl = /^https?:/i.test(abs) && globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
  if (!ctrl || typeof globalThis.__csimSWInterceptFetch !== 'function') return;
  // (…`crossorigin` mapped exactly like the <img> path's)
  const { mode, credentials } = audio._imageCorsRequest();
  const swReq = buildSwRequest({ mode, credentials, destination: 'audio' });
  globalThis.__csimSWInterceptFetch(ctrl, 'GET', abs, {}, null, swReq, (resp) => {
    // (…a fall-through, the network media pipeline not modelled, leaves it under way; a respondWith decides. A media
    // request is no-cors / redirect follow: an opaque response is fine, an opaqueredirect one a network error — the
    // <img> path's gate)
    if (resp == null || !globalThis.__dom.mediaCurrent(audio, load)) return;
    if (resp.__networkError || resp.type === 'opaqueredirect' || (resp.status | 0) >= 400) {
      failLoad(audio);
      return;
    }
    dispatchResourceEvents(audio, load, globalThis.__dom.mediaResource(audio, AUDIO_USABLE));
  });
}

// `volumechange` whenever what `volume` or `muted` returns changes, `ratechange` whenever what `defaultPlaybackRate` or
// `playbackRate` does (§4.8.11.13, §4.8.11.8).
const changed = (el, type) => globalThis.__csimQueueMicrotask(() => dispatchMediaEvent(el, type));

// HTMLMediaElement's members no attribute reflects (HTML §4.8.11), as dom-class-aliases.js installs them with the
// generated binding. Audio we do not decode, so an `<audio>` stays at HAVE_NOTHING with no duration; its playback state
// is a video's — nothing plays, so the current playback position moves only as a script seeks.
export const htmlMediaElementMembers = {
  get_error: errorOf,
  // (…the URL of the resource its load algorithm last selected, '' before one)
  get_currentSrc: (el) => mediaGet(el, CURRENT_SRC),
  // (…NETWORK_EMPTY until a <source> insertion or a load runs resource selection)
  get_networkState: (el) => mediaGet(el, NETWORK_STATE),
  get_buffered: wholeTimeline,
  get_seekable: wholeTimeline,
  get_played: () => timeRangesBinding.create([]),
  load: loadMedia,
  // canPlayType (§4.8.11.3): what the engine answers for the types it knows, by the containers it demuxes and the codecs
  // it decodes (media.rs `can_play_type`).
  canPlayType: (el, type) => globalThis.__dom.canPlayType(type),
  get_readyState: (el) => mediaGet(el, READY_STATE),
  // (…a seek completes as it is asked: never one in progress)
  get_seeking: () => false,
  // Setting currentTime (§4.8.11.8) with no media data (HAVE_NOTHING) only sets the default playback start position,
  // which reads back until there is some; with data, it seeks (`seek`). fastSeek() seeks as precisely.
  get_currentTime: (el) => mediaGet(el, CURRENT_TIME),
  set_currentTime: seek,
  fastSeek: seek,
  // (…NaN with no media data, §4.8.11.6)
  get_duration: (el) => mediaGet(el, DURATION),
  // (…a resource with no explicit timeline offset — none here has one: an invalid Date)
  getStartDate: () => new Date(NaN),
  get_paused: (el) => mediaGet(el, PAUSED),
  get_ended: () => false,
  get_defaultPlaybackRate: (el) => mediaGet(el, DEFAULT_PLAYBACK_RATE),
  set_defaultPlaybackRate(el, rate) {
    if (mediaSet(el, DEFAULT_PLAYBACK_RATE, rate) === CHANGED) changed(el, 'ratechange');
  },
  get_playbackRate: (el) => mediaGet(el, PLAYBACK_RATE),
  set_playbackRate(el, rate) {
    if (mediaSet(el, PLAYBACK_RATE, rate) === CHANGED) changed(el, 'ratechange');
  },
  get_preservesPitch: (el) => mediaGet(el, PRESERVES_PITCH),
  set_preservesPitch(el, value) { mediaSet(el, PRESERVES_PITCH, value); },
  // HTML's internal play steps (§4.8.11.8): a paused element unpaused, `play` then — with no data to play from (up to
  // HAVE_CURRENT_DATA) — `waiting`, or `playing`; one playing already, none. (…a promise: what it throws, a rejection —
  // the binding's)
  play(el) {
    if (mediaSet(el, PAUSED, false) === CHANGED) {
      const next = mediaGet(el, READY_STATE) <= HAVE_CURRENT_DATA ? 'waiting' : 'playing';
      globalThis.__csimQueueMicrotask(() => { dispatchMediaEvent(el, 'play'); dispatchMediaEvent(el, next); });
    }
    return resolvedPromise();
  },
  // …and the internal pause steps: a playing element paused, `timeupdate` then `pause`; one paused already, none.
  pause(el) {
    if (mediaSet(el, PAUSED, true) === CHANGED) {
      globalThis.__csimQueueMicrotask(() => { dispatchMediaEvent(el, 'timeupdate'); dispatchMediaEvent(el, 'pause'); });
    }
  },
  // volume: 0 to 1, 1 until set — another an IndexSizeError (§4.8.11.13).
  get_volume: (el) => mediaGet(el, VOLUME),
  set_volume(el, volume) {
    const owed = mediaSet(el, VOLUME, volume);
    if (owed === OUT_OF_RANGE) {
      throw new DOMException(
        `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${volume}) is outside the range [0, 1].`,
        'IndexSizeError');
    }
    if (owed === CHANGED) changed(el, 'volumechange');
  },
  get_muted: (el) => mediaGet(el, MUTED),
  set_muted(el, muted) {
    if (mediaSet(el, MUTED, muted) === CHANGED) changed(el, 'volumechange');
  }
};
// …a seek (HTML §4.8.11.9): `seeking`, then — the position changed — `timeupdate`, and `seeked` once it is done.
function seek(el, time) {
  if (mediaSet(el, CURRENT_TIME, time) !== CHANGED) return;
  globalThis.__csimQueueMicrotask(() => { for (const type of ['seeking', 'timeupdate', 'seeked']) dispatchMediaEvent(el, type); });
}

// HTMLVideoElement's members no attribute reflects, as dom-class-aliases.js installs them with the generated binding:
// the decoded video's size, 0 × 0 before one is.
export const htmlVideoElementMembers = {
  get_videoWidth: (video) => mediaGet(video, VIDEO_WIDTH),
  get_videoHeight: (video) => mediaGet(video, VIDEO_HEIGHT)
};
