// HTMLMediaElement (HTML §4.8.11) — `<video>` and `<audio>`. A video's resource decodes natively (video.rs, as the
// engine fetches it: subresource_obtain.rs `mediaFetchResource`) to its dimensions, duration and first RGBA frame:
// first-frame thumbnail extraction for uppy-style upload chains (Discourse's composer-video-thumbnail-uppy), the cached
// frame drawn by `drawImage(video, …)` like any ImageBitmap. Audio is not decoded; an `<audio>` has the playback state
// only (Mastodon's sounds: `new Audio()`, play / pause / currentTime / volume).

import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { IntrinsicDate, rejectedPromise, resolvedPromise } from './webidl.js';
import { isHtml } from './constants.js';
import { resolveURLValue } from './base-url.js';
import { obtainHost } from './obtain-host.js';
import { defineMediaError, defineTimeRanges } from './generated/bindings.js';
import { DOMException } from './dom-exception.js';

const isVideo = (node) => isHtml(node, 'video');
const isMedia = (node) => isVideo(node) || isHtml(node, 'audio');
// A media element's state, the engine's (media.rs): what a member reads or writes, by the code the engine names it with.
const NETWORK_STATE = 0, READY_STATE = 1, CURRENT_TIME = 2, DURATION = 3, PAUSED = 4, DEFAULT_PLAYBACK_RATE = 5;
const PLAYBACK_RATE = 6, PRESERVES_PITCH = 7, VOLUME = 8, MUTED = 9, VIDEO_WIDTH = 10, VIDEO_HEIGHT = 11, CURRENT_SRC = 12;
const ERROR = 13;
// …and the ready state that has data for the current position and none past it (§4.8.11.7).
const HAVE_CURRENT_DATA = 2;
// …what a write owes (`mediaSet`): its event, or — a volume out of range — an IndexSizeError.
const CHANGED = 1, OUT_OF_RANGE = 2;
// …and what the load algorithm owes as it begins (`mediaLoad`).
const ABORT = 1, EMPTIED = 2, TIMEUPDATE = 4;
const mediaGet = (el, member) => globalThis.__dom.mediaGet(el, member);
const mediaSet = (el, member, value) => globalThis.__dom.mediaSet(el, member, value);

// HTMLSourceElement's insertion steps, the engine's (media.rs `source_inserted`): a <source> inserted into a media
// element with no `src` whose networkState is NETWORK_EMPTY invokes its resource selection algorithm — NETWORK_NO_SOURCE
// at once, its rest as the stable state comes — and one inserted past the pointer of a children mode that waits for a
// candidate ends the wait. Run as an INSERTION step (during parenting / connect), so it lands BEFORE an
// earlier-inserted script's post-insertion execution (Node-appendChild-script-and-source-from-fragment).
export function runSourceInsertionStep(child, parent) {
  if (!child || !isHtml(child, 'source') || !parent) return;
  const invoked = globalThis.__dom.mediaSourceInserted(parent, child);
  if (invoked === null) return;
  const [load, resumed] = invoked;
  if (!resumed) selectResource(parent, load);
  else globalThis.__csimQueueMicrotask(() => tryCandidates(parent, load));
}

// A failed load/decode discards the PREVIOUS resource: the old frame must not
// stay drawable (its taint verdict no longer applies), matching the media load
// algorithm's dedicated media source failure steps — which set `error` to a
// MEDIA_ERR_SRC_NOT_SUPPORTED MediaError: an empty `src`, a resource that could not
// be fetched, or one we cannot play (audio at all; a codec we do not decode — HEVC,
// Theora — or a corrupt file).
function failLoad(media) {
  globalThis.__dom.mediaFailed(media);
  globalThis.__csimQueueMicrotask(() => dispatchMediaEvent(media, 'error'));
}

// The media element load algorithm (§4.8.11.5), whichever asked — its `src` set, load() — the engine's as far as it
// changes the element's state (media.rs `mediaLoad`): what a load under way had queued dropped; an `abort` for one under
// way or done, and for an element that had any state an `emptied` (a `timeupdate` where it was not at the start); then
// the resource selection algorithm, once the script that asked has run (a stable state) — none where a later load has
// superseded it (`mediaSelect`): with a `src`, `loadstart` and the resource fetched — an empty `src` failing; with a
// `<source>` child, `loadstart` and its candidates tried; else nothing.
function loadMedia(media) {
  const [load, owed] = globalThis.__dom.mediaLoad(media);
  const queue = (type) => globalThis.__csimQueueMicrotask(() => { if (globalThis.__dom.mediaCurrent(media, load)) dispatchMediaEvent(media, type); });
  if (owed & ABORT) queue('abort');
  if (owed & EMPTIED) queue('emptied');
  if (owed & TIMEUPDATE) queue('timeupdate');
  selectResource(media, load);
}
// …the resource selection algorithm's rest, as the stable state comes, under `load`.
function selectResource(media, load) {
  globalThis.__csimQueueMicrotask(() => {
    const src = globalThis.__dom.mediaSelect(media, load);
    if (src === null) return;
    dispatchMediaEvent(media, 'loadstart');
    if (src === true) tryCandidates(media, load);
    else if (src === '') failLoad(media);
    else fetchSelected(media, absoluteURL(media, src), load);
  });
}
// …the children mode's candidates, in tree order from its pointer (media.rs `mediaCandidate`): one that fails at once —
// no usable `src`, a `type` we cannot play, a URL that does not parse — its `error` fired at it and the next tried; the
// first that does not fetched, its own failure the same (`failResource`); none left, the algorithm waits for a
// `<source>` inserted past them (`runSourceInsertionStep`).
function tryCandidates(media, load) {
  for (let candidate; (candidate = globalThis.__dom.mediaCandidate(media, load)) !== null;) {
    const [source, src] = candidate;
    const abs = src === null ? null : resolveURLValue(source, src);
    if (abs != null) { fetchSelected(media, abs, load); return; }
    candidateError(source, media, load);
  }
}
const candidateError = (source, media, load) => globalThis.__csimQueueMicrotask(() => {
  if (globalThis.__dom.mediaCurrent(media, load)) dispatchMediaEvent(source, 'error');
});
// …the selected resource, the element's current source: fetched, or — `preload` putting it off (`mediaFetch`) — its
// `suspend` fired, the fetch waiting for the element to play.
function fetchSelected(media, abs, load) {
  mediaSet(media, CURRENT_SRC, abs);
  if (globalThis.__dom.mediaFetch(media)) fetchResource(media, abs, load);
  else globalThis.__csimQueueMicrotask(() => { if (globalThis.__dom.mediaCurrent(media, load)) dispatchMediaEvent(media, 'suspend'); });
}
// (…a fetch in a document with no browsing context — a `createHTMLDocument`'s, a DOMParser's, template contents' —
// failing: such a document loads nothing) — the engine's (subresource_obtain.rs `mediaFetchResource`: a video's fetched
// and decoded, an audio's fetched, each through a controlling service worker first, its entry filed).
function fetchResource(media, abs, load) {
  if (!globalThis.__dom.documentFullyActive(media._ownerDocument._nid)) failResource(media, load);
  else mediaFetched(media, load, globalThis.__dom.mediaFetchResource(media._nid, media._ownerDocument._nid, abs, load, obtainHost()));
}
// …what it came to: the events its resource owes (media.rs `resource_events`) fired, each while the load that owes it
// is the element's; a failure gone on from; or, a worker's to answer, nothing yet (the engine hands it here then).
export function mediaFetched(media, load, done) {
  if (Array.isArray(done)) globalThis.__csimQueueMicrotask(() => dispatchResourceEvents(media, load, done));
  else if (done !== true) failResource(media, load);
}
// …and its fetch failed: the attribute mode's the element's own failure (`failLoad`), the children mode's its
// candidate's (`mediaCandidateFailed`) — its `error` fired at it, where it is the element's still — and the next one
// tried.
function failResource(media, load) {
  if (!globalThis.__dom.mediaCurrent(media, load)) return;
  const source = globalThis.__dom.mediaCandidateFailed(media);
  if (source === false) { failLoad(media); return; }
  if (source !== null) candidateError(source, media, load);
  tryCandidates(media, load);
}
// The resource selection algorithm invoked other than by the load algorithm (media.rs `mediaInvoke`) on an element
// whose network state is NETWORK_EMPTY: one created with a `src` (`mediaCreated`), one asked to play or pause.
function invokeSelection(media) {
  const load = globalThis.__dom.mediaInvoke(media);
  if (load !== null) selectResource(media, load);
}
// A media element created with a `src` — the parser's, a clone's, whose attribute change steps do not run
// (dom-nodes.js `appendedAttributeSteps`) — invokes its resource selection algorithm at once (HTML §4.8.11.5), wherever
// it is: one in no document's tree loads too.
export function mediaCreated(el) {
  if (isMedia(el)) invokeSelection(el);
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
// its load algorithm; its removal does not. (An element created with its `src` invokes its resource selection
// algorithm: `mediaCreated`.)
export function mediaSrcChanged(el) {
  if (isMedia(el)) loadMedia(el);
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
  getStartDate: () => new IntrinsicDate(NaN),
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
  // HTML's play() (§4.8.11.8): none for an element whose resource is not supported (its error MEDIA_ERR_SRC_NOT_SUPPORTED,
  // every error this model has), its promise rejected; else the internal play steps — an element whose network state is
  // NETWORK_EMPTY invoking its resource selection algorithm, a paused element unpaused, `play` then — with no data to
  // play from (up to HAVE_CURRENT_DATA) — `waiting`, or `playing`; one playing already, none — and the fetch `preload`
  // put off, which playing triggers (`mediaResume`).
  // (…a promise: what it throws, a rejection — the binding's)
  play(el) {
    if (mediaGet(el, ERROR) !== 0) {
      return rejectedPromise(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    }
    invokeSelection(el);
    if (mediaSet(el, PAUSED, false) === CHANGED) {
      const next = mediaGet(el, READY_STATE) <= HAVE_CURRENT_DATA ? 'waiting' : 'playing';
      globalThis.__csimQueueMicrotask(() => { dispatchMediaEvent(el, 'play'); dispatchMediaEvent(el, next); });
    }
    const load = globalThis.__dom.mediaResume(el);
    if (load !== null) fetchResource(el, mediaGet(el, CURRENT_SRC), load);
    return resolvedPromise();
  },
  // …and the internal pause steps: a playing element paused, `timeupdate` then `pause`; one paused already, none.
  // (…each step's first: an element whose network state is NETWORK_EMPTY invokes its resource selection algorithm)
  pause(el) {
    invokeSelection(el);
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
