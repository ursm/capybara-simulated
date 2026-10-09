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
import { installMembers, rejectedPromise, resolvedPromise, toDouble } from './webidl.js';
import { defineMediaError } from './generated/bindings.js';

function isVideo(node) {
  return node && node._tag === 'video';
}

function isMedia(node) {
  return node && (node._tag === 'video' || node._tag === 'audio');
}

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
  if ((parent._csimNetworkState | 0) === 0) parent._csimNetworkState = 3;   // NETWORK_EMPTY → NETWORK_NO_SOURCE
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
  queueMicrotask(() => dispatchMediaEvent(video, 'error'));
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

function decodeAndDispatch(video, src) {
  // (…a new load clears the last one's error, before it knows whether it fails too)
  video._csimMediaError = null;
  // Frame-correct absolute URL (the raw attribute resolved against the MAIN
  // document host-side — the recurring wrong-base class), and a CONTROLLED
  // document's video bytes fetch through its service worker (destination
  // 'video') before the plain host fetch.
  let abs = src;
  try { abs = new globalThis.URL(src, video.baseURI || (globalThis.location && globalThis.location.href) || undefined).href; } catch (_) {}
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
  video._csimNetworkState    = 1; // NETWORK_IDLE — a usable resource loaded, so leave NETWORK_NO_SOURCE if a prior <source> set it
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

function dispatchMediaEvent(video, type) {
  if (video) fireEvent(video, new Event(type));
}

export function onVideoSrcAssigned(video, src) {
  if (!isVideo(video) || !src) return;
  decodeAndDispatch(video, src);
}

// HTMLMediaElement's members — on its prototype, checking `this` is one of its elements. Audio we do not decode, so an
// `<audio>` stays at HAVE_NOTHING with no duration; its playback state is a video's.
export function installMediaIDL({ HTMLMediaElement }) {
  installMembers(HTMLMediaElement.prototype, MediaMembers.prototype);
}

function media(self) {
  if (!isMedia(self)) throw new TypeError('Illegal invocation');
  return self;
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
const reflectBoolean = (el, attr, v) => (v ? el._setAttribute(attr, '') : el._removeAttribute(attr));
const double = (v, member) => toDouble(v, `Failed to set the '${member}' property on 'HTMLMediaElement': `);
// `volumechange` whenever what `volume` or `muted` returns changes (§4.8.11.13).
const volumeChanged = (el) => queueMicrotask(() => dispatchMediaEvent(el, 'volumechange'));

class MediaMembers {
  // (…NaN with no media data, §4.8.11.6)
  get duration() { return media(this)._csimMediaDuration ?? NaN; }
  get readyState() { return media(this)._csimMediaReadyState | 0; }
  // networkState: NETWORK_EMPTY (0) until a <source> insertion / load runs resource selection.
  get networkState() { return media(this)._csimNetworkState | 0; }
  get paused() { return !media(this)._csimMediaPlaying; }
  get ended() { media(this); return false; }
  get error() { return media(this)._csimMediaError || null; }
  // Setting currentTime (§4.8.11.8) with no media data (HAVE_NOTHING) only sets the default playback start position,
  // which reads back until there is some; with data, it seeks — `seeked` fires.
  get currentTime() { return +media(this)._csimMediaCurrentTime || 0; }
  set currentTime(v) {
    const el = media(this);
    el._csimMediaCurrentTime = double(v, 'currentTime');
    if (el._csimMediaReadyState | 0) queueMicrotask(() => dispatchMediaEvent(el, 'seeked'));
  }
  get muted() { return !!media(this)._csimMediaMuted; }
  set muted(v) {
    const el = media(this), muted = !!v;
    if (muted === !!el._csimMediaMuted) return;
    el._csimMediaMuted = muted;
    volumeChanged(el);
  }
  // volume: 0 to 1, 1 until set — another an IndexSizeError (§4.8.11.13).
  get volume() { return media(this)._csimMediaVolume ?? 1; }
  set volume(v) {
    const el = media(this), n = double(v, 'volume');
    if (n < 0 || n > 1) {
      throw new globalThis.DOMException(`Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${n}) is outside the range [0, 1].`, 'IndexSizeError');
    }
    if (n === (el._csimMediaVolume ?? 1)) return;
    el._csimMediaVolume = n;
    volumeChanged(el);
  }
  // (…boolean attributes reflected)
  get autoplay() { return media(this)._attrs.autoplay != null; }
  set autoplay(v) { reflectBoolean(media(this), 'autoplay', v); }
  get loop() { return media(this)._attrs.loop != null; }
  set loop(v) { reflectBoolean(media(this), 'loop', v); }
  get controls() { return media(this)._attrs.controls != null; }
  set controls(v) { reflectBoolean(media(this), 'controls', v); }
  get defaultMuted() { return media(this)._attrs.muted != null; }
  set defaultMuted(v) { reflectBoolean(media(this), 'muted', v); }
  load() {
    const el = media(this);
    if (isVideo(el) && el._attrs.src) decodeAndDispatch(el, el._attrs.src);
  }
  // (…a promise: what it throws, a rejection, Web IDL §3.6.8)
  play() {
    if (!isMedia(this)) return rejectedPromise(new TypeError("Failed to execute 'play' on 'HTMLMediaElement': Illegal invocation"));
    const el = this;
    el._csimMediaPlaying = true;
    queueMicrotask(() => dispatchMediaEvent(el, 'play'));
    return resolvedPromise();
  }
  pause() {
    const el = media(this);
    el._csimMediaPlaying = false;
    queueMicrotask(() => dispatchMediaEvent(el, 'pause'));
  }
  // canPlayType (§4.8.11.3), for a video type: '' for a container we cannot demux or a codec we do not decode in it;
  // 'maybe' for MP4 or WebM with no `codecs` to say what is in it; 'probably' where every codec it names is one we
  // decode there — H.264, VP9 or AV1 in MP4; VP8, VP9 or AV1 in WebM — or an audio one the container carries (an audio
  // track is no obstacle to loading the video, which is all the element does). For an audio type, what Chrome answers
  // (`AUDIO_TYPES`): audio is not decoded at all, but the playback state an element keeps for it does not need it to
  // be, and a page picks the format it plays by the answer (Howler, Modernizr). Chrome's answers, measured — but for
  // Ogg and Matroska (`video/ogg`, `audio/matroska`, …), containers we demux not at all, which Chrome answers maybe.
  canPlayType(type) {
    media(this);
    const m = /^\s*([a-z0-9-]+\/[a-z0-9.+-]+)\s*(?:;(.*))?$/i.exec(String(type));
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
  }
}

// HTMLVideoElement's members no attribute reflects, as dom-class-aliases.js installs them with the generated binding:
// the decoded video's size, 0 × 0 before one is.
export const htmlVideoElementMembers = {
  get_videoWidth: (video) => video._csimVideoWidth | 0,
  get_videoHeight: (video) => video._csimVideoHeight | 0
};
