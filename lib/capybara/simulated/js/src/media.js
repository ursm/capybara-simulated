// HTMLMediaElement (HTML §4.8.11) — `<video>` and `<audio>`. A video's resource decodes natively
// (`__dom.decodeVideo`, video.rs) to its dimensions, duration and first RGBA frame: first-frame thumbnail
// extraction for uppy-style upload chains (Discourse's composer-video-thumbnail-uppy), the cached frame drawn
// by `drawImage(video, …)` like any ImageBitmap. Audio is not decoded; an `<audio>` has the playback state
// only (Mastodon's sounds: `new Audio()`, play / pause / currentTime / volume).

import { latin1ToBytes } from './bytes.js';
import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { blobBytes }                     from './blob.js';
import { processDataUrl }                from './data-url.js';
import { resolvedPromise } from './webidl.js';
import { buildSwRequest } from './sw-client.js';
import { HTML_NS } from './constants.js';
import { defineMediaError, defineTimeRanges } from './generated/bindings.js';

const isVideo = (node) => node._tag === 'video';
const isMedia = (node) => node._ns === HTML_NS && (node._tag === 'video' || node._tag === 'audio');
// (…its network states, HTMLMediaElement's constants)
const NETWORK_EMPTY = 0, NETWORK_IDLE = 1, NETWORK_LOADING = 2, NETWORK_NO_SOURCE = 3;

// HTMLSourceElement insertion step — the synchronous head of the media resource
// selection algorithm. Inserting a <source> into a media element whose
// networkState is NETWORK_EMPTY runs resource selection, whose first step sets
// networkState to NETWORK_NO_SOURCE. We don't model the async load that would
// then move a media with a usable source to NETWORK_LOADING, so NETWORK_NO_SOURCE
// is the stable observable. Run as an INSERTION step (during parenting / connect),
// so it lands BEFORE an earlier-inserted script's post-insertion execution
// (Node-appendChild-script-and-source-from-fragment).
export function runSourceInsertionStep(child, parent) {
  if (!child || child._tag !== 'source') return;
  if (!parent || (parent._tag !== 'video' && parent._tag !== 'audio')) return;
  if ((parent._csimNetworkState | 0) === NETWORK_EMPTY) parent._csimNetworkState = NETWORK_NO_SOURCE;
}

// Resolve a media `src` to its bytes (a Uint8Array) for the decoder. A `blob:`
// URL reads the in-VM blob store, then the host registry; a `data:` URL decodes its
// payload; anything else (http / relative) is fetched on the Ruby side. Returns null when
// the source can't be resolved.
function videoBytes(src) {
  if (!src) return null;
  if (src.startsWith('blob:')) {
    // Fragment is not part of the blob resource identity (matches resolveBlobBytes).
    const key = src.split('#')[0];
    const blob = globalThis.__csimBlobs && globalThis.__csimBlobs.get(key);
    if (blob) return latin1ToBytes(blobBytes(blob));
    const bytes = typeof globalThis.__csim_blobResolve === 'function' ? globalThis.__csim_blobResolve(key) : null;
    return bytes && bytes.length ? bytes : null;
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
// MEDIA_ERR_SRC_NOT_SUPPORTED MediaError: a resource that could not be fetched,
// or is no video we can play (a codec we do not decode — HEVC, Theora — or a
// corrupt file).
function failLoad(video) {
  video._csimVideoFrame      = null;
  video._csimMediaDuration   = undefined;   // (…no media data: NaN)
  video._csimMediaReadyState = 0;   // HAVE_NOTHING
  video._csimMediaError      = mediaError(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, 'The video could not be loaded or decoded.');
  video._csimNetworkState    = NETWORK_NO_SOURCE;
  queueMicrotask(() => dispatchMediaEvent(video, 'error'));
}

// The media element load algorithm's head (§4.8.11.5), as a load starts: an `abort` for one under way or done, and for
// an element that had any state an `emptied`, that state forgotten — no media data, paused, at the start, no duration —
// then resource selection's: the network loading, a `loadstart`.
function beginLoad(media) {
  const state = media._csimNetworkState | 0;
  if (state === NETWORK_LOADING || state === NETWORK_IDLE) queueMicrotask(() => dispatchMediaEvent(media, 'abort'));
  if (state !== NETWORK_EMPTY) {
    queueMicrotask(() => dispatchMediaEvent(media, 'emptied'));
    media._csimMediaReadyState = 0;
    media._csimMediaPlaying = false;
    media._csimMediaCurrentTime = 0;
    media._csimMediaDuration = undefined;
  }
  media._csimNetworkState = NETWORK_LOADING;
  queueMicrotask(() => dispatchMediaEvent(media, 'loadstart'));
}

// MediaError (HTML §4.8.11.1), generated from its IDL: why a media element's resource failed — its code and message, in
// its slots. Made by the platform alone.
const mediaErrorBinding = defineMediaError({
  init(s, code, message) { s.code = code; s.message = message; },
  get_code: (s) => s.code,
  get_message: (s) => s.message
});
const MediaError = mediaErrorBinding.interface;
const mediaError = (code, message) => mediaErrorBinding.create(code, message);
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
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'TimeRanges': The index provided (${index}) is greater than or equal to the maximum bound (${s.ranges.length}).`,
      'IndexSizeError');
  }
  return s.ranges[index];
}
globalThis.TimeRanges = timeRangesBinding.interface;
// (…the whole of a decoded resource's timeline, none before there is one: nothing streams, so a resource is all there
// as it loads)
const wholeTimeline = (el) =>
  timeRangesBinding.create(Number.isFinite(el._csimMediaDuration) ? [[0, el._csimMediaDuration]] : []);

// (…the `src` resolved against the element's base URL, as the resource selection algorithm takes it — as it is where it
// does not parse)
function absoluteURL(el, src) {
  try { return new globalThis.URL(src, el.baseURI || (globalThis.location && globalThis.location.href) || undefined).href; } catch (_) { return src; }
}

function decodeAndDispatch(video, src) {
  // (…a new load clears the last one's error, before it knows whether it fails too)
  video._csimMediaError = null;
  beginLoad(video);
  // Frame-correct absolute URL (the raw attribute resolved against the MAIN
  // document host-side — the recurring wrong-base class), and a CONTROLLED
  // document's video bytes fetch through its service worker (destination
  // 'video') before the plain host fetch.
  const abs = absoluteURL(video, src);
  video._csimCurrentSrc = abs;
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
      bytes = videoBytes(src);   // blob:/data: — same-origin-ish, never taints
    }
  }
  if (!bytes) { failLoad(video); return; }
  const decoded = globalThis.__dom.decodeVideo(bytes);
  if (!decoded) { failLoad(video); return; }
  video._tainted           = tainted;
  video._csimVideoWidth    = decoded.width;
  video._csimVideoHeight   = decoded.height;
  video._csimMediaDuration = decoded.duration;
  video._csimVideoFrame    = {width: decoded.width, height: decoded.height, _pixels: decoded.pixels};
  video._csimMediaReadyState = 4; // HAVE_ENOUGH_DATA
  video._csimNetworkState    = NETWORK_IDLE;   // (…a usable resource loaded)
  queueMicrotask(() => {
    dispatchMediaEvent(video, 'loadedmetadata');
    dispatchMediaEvent(video, 'loadeddata');
    dispatchMediaEvent(video, 'canplay');
    dispatchMediaEvent(video, 'canplaythrough');
    // HTML "ready for playback" + `autoplay`: playback begins — `paused` flips
    // false and play/playing fire (the canvas-tainting helper draws on onplay).
    if (video._attrs.autoplay != null && !video._csimMediaPlaying) {
      video._csimMediaPlaying = true;
      dispatchMediaEvent(video, 'play');
      dispatchMediaEvent(video, 'playing');
    }
  });
}

function dispatchMediaEvent(media, type) {
  fireEvent(media, new Event(type));
}

// A media element's `src` attribute set or changed (HTML §4.8.11.2) — by any route, to the value it had too — invokes
// its load algorithm; its removal does not. A video's resource decodes (decodeAndDispatch); an audio's is not decoded, but in a CONTROLLED
// document it fetches through the service worker (destination audio — the fetch IS the observable; fetch-destination
// asserts it) and a usable response fires the readiness ladder to canplaythrough, a refused one `error`. An
// UNCONTROLLED document fetches no audio — playback is not modelled, and fetching every app's <audio src> would be pure
// cost (rule 3). Not yet for an element the parser creates with its `src` (attribute change steps do not run there).
export function mediaSrcChanged(el) {
  if (!isMedia(el)) return;
  const src = el._attrs.src;
  if (src == null || src === '') return;
  if (isVideo(el)) decodeAndDispatch(el, src);
  else loadAudio(el, src);
}
function loadAudio(audio, src) {
  const abs = absoluteURL(audio, src);
  audio._csimCurrentSrc = abs;
  const ctrl = /^https?:/i.test(abs) && globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
  if (!ctrl || typeof globalThis.__csimSWInterceptFetch !== 'function') return;
  // (…`crossorigin` mapped exactly like the <img> path's)
  const { mode, credentials } = audio._imageCorsRequest();
  const swReq = buildSwRequest({ mode, credentials, destination: 'audio' });
  globalThis.__csimSWInterceptFetch(ctrl, 'GET', abs, {}, null, swReq, (resp) => {
    // (…a fall-through, the network media pipeline not modelled, leaves it inert; a respondWith decides. A media
    // request is no-cors / redirect follow: an opaque response is fine, an opaqueredirect one a network error — the
    // <img> path's gate)
    if (resp == null) return;
    if (resp.__networkError || resp.type === 'opaqueredirect' || (resp.status | 0) >= 400) {
      dispatchMediaEvent(audio, 'error');
      return;
    }
    for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough']) dispatchMediaEvent(audio, type);
  });
}

// The types `canPlayType` knows, by container: its answer with no `codecs` parameter, and the codecs it plays.
const VIDEO_TYPES = {
  'video/mp4': { bare: 'maybe', codecs: /^(avc1|avc3|av01|vp09|mp4a)(\.|$)|^(opus|flac|mp3)$/ },
  'video/webm': { bare: 'maybe', codecs: /^(av01|vp09)(\.|$)|^(vp8|vp9)(\.0)?$|^(opus|vorbis)$/ }
};
const MP4_AUDIO = /^mp4a(\.|$)|^(flac|opus|mp3)$/;
// (…a container named with no codec it plays: any `codecs` given names one it does not)
const NO_CODEC = /(?!)/;
const AUDIO_TYPES = {
  'audio/mpeg': { bare: 'probably', codecs: /^mp3$/ },
  'audio/mp3': { bare: 'probably', codecs: /^mp3$/ },
  'audio/aac': { bare: 'probably', codecs: NO_CODEC },
  'audio/flac': { bare: 'probably', codecs: NO_CODEC },
  'audio/mp4': { bare: 'maybe', codecs: MP4_AUDIO },
  'audio/x-m4a': { bare: 'maybe', codecs: MP4_AUDIO },
  'audio/ogg': { bare: 'maybe', codecs: /^(vorbis|opus|flac)$/ },
  'audio/webm': { bare: 'maybe', codecs: /^(vorbis|opus)$/ },
  'audio/wav': { bare: 'maybe', codecs: /^1$/ },
  'audio/x-wav': { bare: 'maybe', codecs: /^1$/ }
};
// `volumechange` whenever what `volume` or `muted` returns changes, `ratechange` whenever what `defaultPlaybackRate` or
// `playbackRate` does (§4.8.11.13, §4.8.11.8).
const changed = (el, type) => queueMicrotask(() => dispatchMediaEvent(el, type));

// HTMLMediaElement's members no attribute reflects (HTML §4.8.11), as dom-class-aliases.js installs them with the
// generated binding. Audio we do not decode, so an `<audio>` stays at HAVE_NOTHING with no duration; its playback state
// is a video's — nothing plays, so the current playback position moves only as a script seeks.
export const htmlMediaElementMembers = {
  get_error: (el) => el._csimMediaError || null,
  // (…the URL of the resource its load algorithm last selected, '' before one)
  get_currentSrc: (el) => el._csimCurrentSrc ?? '',
  // (…NETWORK_EMPTY until a <source> insertion or a load runs resource selection)
  get_networkState: (el) => el._csimNetworkState | 0,
  get_buffered: wholeTimeline,
  get_seekable: wholeTimeline,
  get_played: () => timeRangesBinding.create([]),
  load(el) {
    if (isVideo(el)) {
      if (el._attrs.src) decodeAndDispatch(el, el._attrs.src);
    } else if (el._attrs.src) {
      loadAudio(el, el._attrs.src);
    }
  },
  // canPlayType (§4.8.11.3), for a video type: '' for a container we cannot demux or a codec we do not decode in it;
  // 'maybe' for MP4 or WebM with no `codecs` to say what is in it; 'probably' where every codec it names is one we
  // decode there — H.264, VP9 or AV1 in MP4; VP8, VP9 or AV1 in WebM — or an audio one the container carries (an audio
  // track is no obstacle to loading the video, which is all the element does). For an audio type, what Chrome answers
  // (`AUDIO_TYPES`): audio is not decoded at all, but the playback state an element keeps for it does not need it to
  // be, and a page picks the format it plays by the answer (Howler, Modernizr). Chrome's answers, measured — but for
  // Ogg and Matroska (`video/ogg`, `audio/matroska`, …), containers we demux not at all, which Chrome answers maybe.
  canPlayType(el, type) {
    const m = /^\s*([a-z0-9-]+\/[a-z0-9.+-]+)\s*(?:;(.*))?$/i.exec(type);
    if (!m) return '';
    const container = m[1].toLowerCase();
    const codecs = m[2] && /(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(m[2]);
    const known = VIDEO_TYPES[container] || AUDIO_TYPES[container];
    if (!known) return '';
    // (…an empty `codecs` saying no more than none; an empty item in a list naming no codec we play — Chrome)
    const named = codecs ? codecs[1] ?? codecs[2] : '';
    if (named.trim() === '') return known.bare;
    const list = named.split(',').map(c => c.trim().toLowerCase());
    return list.every(c => known.codecs.test(c)) ? 'probably' : '';
  },
  get_readyState: (el) => el._csimMediaReadyState | 0,
  // (…a seek completes as it is asked: never one in progress)
  get_seeking: () => false,
  // Setting currentTime (§4.8.11.8) with no media data (HAVE_NOTHING) only sets the default playback start position,
  // which reads back until there is some; with data, it seeks — `seeked` fires. fastSeek() seeks as precisely.
  get_currentTime: (el) => +el._csimMediaCurrentTime || 0,
  set_currentTime: seek,
  fastSeek: seek,
  // (…NaN with no media data, §4.8.11.6)
  get_duration: (el) => el._csimMediaDuration ?? NaN,
  // (…a resource with no explicit timeline offset — none here has one: an invalid Date)
  getStartDate: () => new Date(NaN),
  get_paused: (el) => !el._csimMediaPlaying,
  get_ended: () => false,
  get_defaultPlaybackRate: (el) => el._csimDefaultPlaybackRate ?? 1,
  set_defaultPlaybackRate(el, rate) {
    if (rate === (el._csimDefaultPlaybackRate ?? 1)) return;
    el._csimDefaultPlaybackRate = rate;
    changed(el, 'ratechange');
  },
  get_playbackRate: (el) => el._csimPlaybackRate ?? 1,
  set_playbackRate(el, rate) {
    if (rate === (el._csimPlaybackRate ?? 1)) return;
    el._csimPlaybackRate = rate;
    changed(el, 'ratechange');
  },
  get_preservesPitch: (el) => el._csimPreservesPitch ?? true,
  set_preservesPitch(el, value) { el._csimPreservesPitch = value; },
  // (…a promise: what it throws, a rejection — the binding's)
  play(el) {
    el._csimMediaPlaying = true;
    queueMicrotask(() => dispatchMediaEvent(el, 'play'));
    return resolvedPromise();
  },
  pause(el) {
    el._csimMediaPlaying = false;
    queueMicrotask(() => dispatchMediaEvent(el, 'pause'));
  },
  // volume: 0 to 1, 1 until set — another an IndexSizeError (§4.8.11.13).
  get_volume: (el) => el._csimMediaVolume ?? 1,
  set_volume(el, volume) {
    if (volume < 0 || volume > 1) {
      throw new globalThis.DOMException(
        `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${volume}) is outside the range [0, 1].`,
        'IndexSizeError');
    }
    if (volume === (el._csimMediaVolume ?? 1)) return;
    el._csimMediaVolume = volume;
    changed(el, 'volumechange');
  },
  get_muted: (el) => !!el._csimMediaMuted,
  set_muted(el, muted) {
    if (muted === !!el._csimMediaMuted) return;
    el._csimMediaMuted = muted;
    changed(el, 'volumechange');
  }
};
function seek(el, time) {
  el._csimMediaCurrentTime = time;
  if (el._csimMediaReadyState | 0) queueMicrotask(() => dispatchMediaEvent(el, 'seeked'));
}

// HTMLVideoElement's members no attribute reflects, as dom-class-aliases.js installs them with the generated binding:
// the decoded video's size, 0 × 0 before one is.
export const htmlVideoElementMembers = {
  get_videoWidth: (video) => video._csimVideoWidth | 0,
  get_videoHeight: (video) => video._csimVideoHeight | 0
};
