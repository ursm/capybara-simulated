// HTMLMediaElement (HTML §4.8.11) — `<video>` and `<audio>` — the bindings of the engine's (media.rs): its load and
// resource selection algorithms, its fetch (subresource_obtain.rs `fetch_media`) and media data processing — a video's
// resource decoded natively (video.rs) to its dimensions, duration and first RGBA frame: first-frame thumbnail extraction
// for uppy-style upload chains (Discourse's composer-video-thumbnail-uppy), the frame drawn by `drawImage(video, …)` like
// any ImageBitmap; audio not decoded, an `<audio>`'s duration read off its container (audio.rs; Mastodon's sounds:
// `new Audio()`, play / pause / currentTime / volume) — and every event each step owes, fired from a media element task. Here, the members and the
// MediaError and TimeRanges objects.

import { IntrinsicDate, IntrinsicPromise, rejectedPromise } from './webidl.js';
import { isHtml } from './constants.js';
import { obtainHost } from './obtain-host.js';
import { defineMediaError, defineTimeRanges } from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { dom, hostSteps, listPush, newList, pageList } from './engine.js';
import { rareDataOf } from './native-query-shadow.js';
import { InternalWeakMap, numberIsFinite } from './intrinsics.js';

const isMedia = (node) => isHtml(node, 'video') || isHtml(node, 'audio');
// A media element's state, the engine's (media.rs): what a member reads or writes, by the code the engine names it with.
const NETWORK_STATE = 0, READY_STATE = 1, CURRENT_TIME = 2, DURATION = 3, PAUSED = 4, DEFAULT_PLAYBACK_RATE = 5;
const PLAYBACK_RATE = 6, PRESERVES_PITCH = 7, VOLUME = 8, MUTED = 9, VIDEO_WIDTH = 10, VIDEO_HEIGHT = 11, CURRENT_SRC = 12;
const ERROR = 13;
// …and what a write owes (`mediaSet`): an IndexSizeError, a volume out of range (its events the engine queues).
const OUT_OF_RANGE = 2;
// …and what play() comes to (`mediaPlay`): played, or why not.
const PLAYED = 0, NOT_ALLOWED = 1, ABORTED = 3;
// …and its pending play promises, settled by the engine's media element tasks: resolved (`PLAYED`), or rejected with an
// AbortError (`ABORTED`: paused, or loaded again, first) or a NotSupportedError (its resource failed).
hostSteps.settlePlayPromises = (el, how) => {
  const rare = rareDataOf(el);
  const pending = rare && rare.playPromises;
  if (!pending) return;
  rare.playPromises = undefined;
  for (let i = 0; i < pending.length; i++) {
    if (how === PLAYED) pending[i][0]();
    else pending[i][1](how === ABORTED
      ? new DOMException('The play() request was interrupted.', 'AbortError')
      : new DOMException('The element has no supported sources.', 'NotSupportedError'));
  }
};
const mediaGet = (el, member) => dom.mediaGet(el, member);
const mediaSet = (el, member, value) => dom.mediaSet(el, member, value);

// HTMLSourceElement's insertion steps, the engine's (media.rs `mediaSourceInserted`): a <source> inserted into a media
// element with no `src` whose networkState is NETWORK_EMPTY invokes its resource selection algorithm, and one inserted
// past the pointer of a children mode that waits for a candidate ends the wait. Run as an INSERTION step (during
// parenting / connect), so it lands BEFORE an earlier-inserted script's post-insertion execution
// (Node-appendChild-script-and-source-from-fragment).
export function runSourceInsertionStep(child, parent) {
  if (child && parent && isHtml(child, 'source')) dom.mediaSourceInserted(parent, child, obtainHost());
}
// The media element load algorithm (§4.8.11.5), whichever asked — its `src` set, load() — the engine's (media.rs
// `mediaLoad`): its resource selection, fetch and media data processing, every event fired from a media element task.
function loadMedia(media) {
  dom.mediaLoad(media, obtainHost());
}
// A media element created with a `src` — the parser's, a clone's, whose attribute change steps do not run
// (dom-nodes.js `appendedAttributeSteps`) — invokes its resource selection algorithm at once (HTML §4.8.11.5), wherever
// it is: one in no document's tree loads too.
export function mediaCreated(el) {
  if (isMedia(el)) dom.mediaInvoke(el, obtainHost());
}

// MediaError (HTML §4.8.11.1), generated from its IDL: why a media element's resource failed — its code and message, in
// its slots. Made by the platform alone, one for each failure the engine counts (`mediaGet(…, ERROR)`), kept per element.
const mediaErrorBinding = defineMediaError({
  init(s, code, message) { s.code = code; s.message = message; }
});
const MediaError = mediaErrorBinding.interface;
const mediaErrors = new InternalWeakMap();
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
  return timeRangesBinding.create(numberIsFinite(duration) ? [[0, duration]] : pageList());
}

// A media element's `src` attribute set or changed (HTML §4.8.11.2) — by any route, to the value it had too — invokes
// its load algorithm; its removal does not. (An element created with its `src` invokes its resource selection
// algorithm: `mediaCreated`.)
export function mediaSrcChanged(el) {
  if (isMedia(el)) loadMedia(el);
}
// HTMLMediaElement's members no attribute reflects (HTML §4.8.11), as dom-class-aliases.js installs them with the
// generated binding. An `<audio>`'s state is a video's but for a size and a frame — its duration its container's — and
// nothing plays, so the current playback position moves only as a script seeks.
export const htmlMediaElementMembers = {
  get_error: errorOf,
  // (…the URL of the resource its load algorithm last selected, '' before one)
  get_currentSrc: (el) => mediaGet(el, CURRENT_SRC),
  // (…NETWORK_EMPTY until a <source> insertion or a load runs resource selection)
  get_networkState: (el) => mediaGet(el, NETWORK_STATE),
  get_buffered: wholeTimeline,
  get_seekable: wholeTimeline,
  get_played: () => timeRangesBinding.create(pageList()),
  load: loadMedia,
  // canPlayType (§4.8.11.3): what the engine answers for the types it knows, by the containers it demuxes and the codecs
  // it decodes (media.rs `can_play_type`).
  canPlayType: (el, type) => dom.canPlayType(type),
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
  set_defaultPlaybackRate(el, rate) { mediaSet(el, DEFAULT_PLAYBACK_RATE, rate); },
  get_playbackRate: (el) => mediaGet(el, PLAYBACK_RATE),
  set_playbackRate(el, rate) { mediaSet(el, PLAYBACK_RATE, rate); },
  get_preservesPitch: (el) => mediaGet(el, PRESERVES_PITCH),
  set_preservesPitch(el, value) { mediaSet(el, PRESERVES_PITCH, value); },
  // HTML's play() and pause() (§4.8.11.8), the engine's (media.rs `mediaPlay`, `mediaPause`): play() rejected with a
  // NotAllowedError for an element not allowed to play (an audible one on a page no user has interacted with: the
  // autoplay policy Chrome and Firefox share), with a NotSupportedError for one whose resource is not supported (its
  // error MEDIA_ERR_SRC_NOT_SUPPORTED, every error this model has); else a pending play promise, which the engine settles
  // (`settlePlayPromises`): resolved as the element is playing, rejected where it is paused or loaded again first.
  // (…a promise: what it throws, a rejection — the binding's)
  play(el) {
    const played = dom.mediaPlay(el, obtainHost());
    if (played === NOT_ALLOWED) {
      return rejectedPromise(new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError'));
    }
    if (played !== PLAYED) return rejectedPromise(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    return new IntrinsicPromise((resolve, reject) => { listPush(rareDataOf(el, true).playPromises ??= newList(), [resolve, reject]); });
  },
  pause(el) { dom.mediaPause(el, obtainHost()); },
  // volume: 0 to 1, 1 until set — another an IndexSizeError (§4.8.11.13).
  get_volume: (el) => mediaGet(el, VOLUME),
  set_volume(el, volume) {
    const owed = mediaSet(el, VOLUME, volume);
    if (owed === OUT_OF_RANGE) {
      throw new DOMException(
        `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${volume}) is outside the range [0, 1].`,
        'IndexSizeError');
    }
  },
  get_muted: (el) => mediaGet(el, MUTED),
  set_muted(el, muted) { mediaSet(el, MUTED, muted); }
};
// …a seek (HTML §4.8.11.9): its `seeking`, `timeupdate` and `seeked` the engine's to queue.
function seek(el, time) {
  mediaSet(el, CURRENT_TIME, time);
}

// HTMLVideoElement's members no attribute reflects, as dom-class-aliases.js installs them with the generated binding:
// the decoded video's size, 0 × 0 before one is.
export const htmlVideoElementMembers = {
  get_videoWidth: (video) => mediaGet(video, VIDEO_WIDTH),
  get_videoHeight: (video) => mediaGet(video, VIDEO_HEIGHT)
};
