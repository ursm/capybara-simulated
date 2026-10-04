// HTMLVideoElement — first-frame thumbnail extraction for uppy-style
// upload chains (Discourse's composer-video-thumbnail-uppy). The resource
// decodes natively (`__dom.decodeVideo`, video.rs) to its dimensions,
// duration and first RGBA frame; we expose the IDL surface (`videoWidth`,
// `videoHeight`, `oncanplaythrough`, `error`, etc.) and the cached frame so
// that `drawImage(video, …)` blits like any ImageBitmap.

import { latin1ToBytes } from './bytes.js';
import { blobBytes }                     from './blob.js';
import { processDataUrl }                from './data-url.js';

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
  video._csimVideoReadyState = 0;   // HAVE_NOTHING
  video._csimMediaError      = mediaError(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, 'The video could not be loaded or decoded.');
  queueMicrotask(() => dispatchVideoEvent(video, 'error'));
}

// MediaError (HTML §4.8.11.1): why a media element's resource failed. Not constructible from script.
export class MediaError {
  constructor() { throw new globalThis.TypeError('Illegal constructor'); }
  get code()    { return this._code; }
  get message() { return this._message; }
  get [Symbol.toStringTag]() { return 'MediaError'; }
}
for (const [name, value] of [['MEDIA_ERR_ABORTED', 1], ['MEDIA_ERR_NETWORK', 2], ['MEDIA_ERR_DECODE', 3], ['MEDIA_ERR_SRC_NOT_SUPPORTED', 4]]) {
  Object.defineProperty(MediaError, name, {value, enumerable: true});
  Object.defineProperty(MediaError.prototype, name, {value, enumerable: true});
}
function mediaError(code, message) {
  const e = Object.create(MediaError.prototype);
  e._code = code;
  e._message = message;
  return e;
}
globalThis.MediaError = MediaError;

function decodeAndDispatch(video, src) {
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
  video._csimMediaError    = null;
  video._csimVideoWidth    = decoded.width;
  video._csimVideoHeight   = decoded.height;
  video._csimVideoDuration = decoded.duration;
  video._csimVideoFrame    = {width: decoded.width, height: decoded.height, _pixels: decoded.pixels};
  video._csimVideoReadyState = 4; // HAVE_ENOUGH_DATA
  video._csimNetworkState    = 1; // NETWORK_IDLE — a usable resource loaded, so leave NETWORK_NO_SOURCE if a prior <source> set it
  queueMicrotask(() => {
    dispatchVideoEvent(video, 'loadedmetadata');
    dispatchVideoEvent(video, 'loadeddata');
    dispatchVideoEvent(video, 'canplay');
    dispatchVideoEvent(video, 'canplaythrough');
    // HTML "ready for playback" + `autoplay`: playback begins — `paused` flips
    // false and play/playing fire (the canvas-tainting helper draws on onplay).
    if (video._attrs.autoplay != null && !video._csimVideoPlaying) {
      video._csimVideoPlaying = true;
      dispatchVideoEvent(video, 'play');
      dispatchVideoEvent(video, 'playing');
    }
  });
}

function dispatchVideoEvent(video, type) {
  if (!video) return;
  const Ctor = globalThis.Event || function (t) { this.type = t; };
  const ev   = new Ctor(type, {bubbles: false, cancelable: false});
  if (typeof video.dispatchEvent === 'function') {
    // dispatchEvent fires the `on<type>` IDL / inline handler itself (it's a
    // registered listener now — see events.js installEventHandlerAttrs), so do NOT
    // also invoke it here or it double-fires.
    try { video.dispatchEvent(ev); } catch (_) {}
  } else {
    // Fallback for a stub without dispatchEvent: invoke the on-handler directly.
    const handler = video['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(video, ev); } catch (_) {}
    }
  }
}

export function onVideoSrcAssigned(video, src) {
  if (!isVideo(video) || !src) return;
  decodeAndDispatch(video, src);
}

// Tag-gated accessors: every getter returns undefined on a non-media element so
// VALUE-based feature detection doesn't see leaked state. (The accessors live on
// the single shared Element.prototype, so `'videoWidth' in document.body` is true
// — an accepted consequence of that design; value-correctness, not the `in`
// operator, is what callers rely on.)
export function installVideoIDL(ElementCtor) {
  const proto = ElementCtor.prototype;
  if (proto._csimVideoIDLInstalled) return;
  proto._csimVideoIDLInstalled = true;

  const def = (name, get, set) => Object.defineProperty(proto, name, {configurable: true, get, set});

  def('videoWidth',   function () { return isVideo(this) ? (this._csimVideoWidth  | 0) : undefined; });
  def('videoHeight',  function () { return isVideo(this) ? (this._csimVideoHeight | 0) : undefined; });
  def('duration',     function () { return isVideo(this) ? (+this._csimVideoDuration || 0) : undefined; });
  def('readyState',   function () { return isVideo(this) ? (this._csimVideoReadyState | 0) : undefined; });
  // networkState is a media (video|audio) property; NETWORK_EMPTY (0) until a
  // <source> insertion / load runs resource selection.
  def('networkState', function () { return isMedia(this) ? (this._csimNetworkState | 0) : undefined; });
  def('paused',       function () { return isVideo(this) ? !this._csimVideoPlaying : undefined; });
  def('ended',        function () { return isVideo(this) ? false : undefined; });
  def('error',        function () { return isVideo(this) ? (this._csimMediaError || null) : undefined; });

  def('currentTime',
    function ()  { return isVideo(this) ? (+this._csimVideoCurrentTime || 0) : undefined; },
    function (v) {
      if (!isVideo(this)) return;
      this._csimVideoCurrentTime = +v || 0;
      queueMicrotask(() => dispatchVideoEvent(this, 'seeked'));
    });
  def('muted',
    function ()  { return isVideo(this) ? !!this._csimVideoMuted : undefined; },
    function (v) { if (isVideo(this)) this._csimVideoMuted = !!v; });
  // autoplay reflects on HTMLMediaElement (both <video> AND <audio>).
  def('autoplay',
    function ()  { return isMedia(this) ? this._attrs.autoplay != null : undefined; },
    function (v) { if (isMedia(this)) v ? this.setAttribute('autoplay', '') : this.removeAttribute('autoplay'); });
  def('playsInline',
    function ()  { return isVideo(this) ? this._attrs.playsinline != null : undefined; },
    function (v) { if (isVideo(this)) v ? this.setAttribute('playsinline', '') : this.removeAttribute('playsinline'); });

  proto.load = function () {
    if (isVideo(this) && this._attrs.src) decodeAndDispatch(this, this._attrs.src);
  };
  proto.play = function () {
    if (!isVideo(this)) return Promise.resolve();
    this._csimVideoPlaying = true;
    queueMicrotask(() => dispatchVideoEvent(this, 'play'));
    return Promise.resolve();
  };
  proto.pause = function () {
    if (!isVideo(this)) return;
    this._csimVideoPlaying = false;
    queueMicrotask(() => dispatchVideoEvent(this, 'pause'));
  };
  // canPlayType (§4.8.11.3): '' for a container we cannot demux or a codec we do not decode; 'maybe' for MP4 or
  // WebM with no `codecs` to say what is in it; 'probably' where every codec it names is one we decode (H.264, VP8,
  // VP9, AV1) or an audio one (Opus, Vorbis, AAC, FLAC, MP3) — an audio track is no obstacle to loading the video,
  // which is all the element does.
  proto.canPlayType = function (type) {
    if (!isVideo(this)) return '';
    const m = /^\s*video\/(mp4|webm)\s*(?:;(.*))?$/i.exec(String(type));
    if (!m) return '';
    const codecs = m[2] && /(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(m[2]);
    if (!codecs) return 'maybe';
    const list = (codecs[1] ?? codecs[2]).split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
    return list.length && list.every(c => /^(avc1|avc3|av01|vp09|mp4a)(\.|$)|^(vp8|vp9|opus|vorbis|flac|mp3)$/.test(c)) ? 'probably' : '';
  };
}
