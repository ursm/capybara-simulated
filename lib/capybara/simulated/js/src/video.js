// HTMLVideoElement — first-frame thumbnail extraction for uppy-style
// upload chains (Discourse's composer-video-thumbnail-uppy). ffprobe
// + ffmpeg on the Ruby side give us dimensions, duration, and the
// first RGBA frame; we expose the IDL surface (`videoWidth`,
// `videoHeight`, `oncanplaythrough`, etc.) and the cached frame so
// that `drawImage(video, …)` blits like any ImageBitmap.

import { fetchTransfer } from './bytes.js';
import { blobBytes }     from './blob.js';

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

// Resolve a media `src` to base64-encoded bytes for the ffmpeg decoder. A `blob:`
// URL reads the in-VM blob store; a base64 `data:` URL passes its payload straight
// through; anything else (http / relative) is fetched on the Ruby side so the binary
// bytes never cross the V8 boundary as a raw (UTF-8-mangling) string. Returns null when
// the source can't be resolved.
function videoBytesB64(src) {
  if (!src) return null;
  if (src.startsWith('blob:')) {
    // Fragment is not part of the blob resource identity (matches resolveBlobBytes).
    const key = src.split('#')[0];
    const blob = globalThis.__csimBlobs && globalThis.__csimBlobs.get(key);
    if (blob) { try { return globalThis.btoa(blobBytes(blob)); } catch (_) { return null; } }
    if (typeof globalThis.__csim_blobResolve === 'function') {
      const b64 = globalThis.__csim_blobResolve(key);
      if (b64) return String(b64);   // already base64
    }
    return null;
  }
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    const meta = src.slice(5, comma), payload = src.slice(comma + 1);
    if (/;base64/i.test(meta)) return payload;   // a media data: URL carries base64 already
    // Non-base64 data: URL — percent-decode to BYTES (each %XX → one byte), not to a
    // UTF-8 string, so binary media survives (btoa on a >0xFF code point would throw).
    try {
      const bytes = payload.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return globalThis.btoa(bytes);
    } catch (_) { return null; }
  }
  if (typeof globalThis.__csim_videoBytesB64 === 'function') {
    const b64 = globalThis.__csim_videoBytesB64(src);
    return b64 ? String(b64) : null;
  }
  return null;
}

function decodeAndDispatch(video, src) {
  const b64 = videoBytesB64(src);
  if (!b64) {
    queueMicrotask(() => dispatchVideoEvent(video, 'error'));
    return;
  }
  const decoded = globalThis.__csim_decodeVideoFrame(b64);
  if (!decoded) {
    queueMicrotask(() => dispatchVideoEvent(video, 'error'));
    return;
  }
  video._csimVideoWidth    = decoded.width  | 0;
  video._csimVideoHeight   = decoded.height | 0;
  video._csimVideoDuration = +decoded.duration || 0;
  const pixels = fetchTransfer(decoded.refId);
  if (pixels) {
    video._csimVideoFrame = {
      width:   video._csimVideoWidth,
      height:  video._csimVideoHeight,
      _pixels: new globalThis.Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    };
  }
  video._csimVideoReadyState = 4; // HAVE_ENOUGH_DATA
  video._csimNetworkState    = 1; // NETWORK_IDLE — a usable resource loaded, so leave NETWORK_NO_SOURCE if a prior <source> set it
  queueMicrotask(() => {
    dispatchVideoEvent(video, 'loadedmetadata');
    dispatchVideoEvent(video, 'loadeddata');
    dispatchVideoEvent(video, 'canplay');
    dispatchVideoEvent(video, 'canplaythrough');
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
  proto.canPlayType = function (type) {
    if (!isVideo(this)) return '';
    const t = String(type || '').toLowerCase();
    if (/video\/(webm|mp4|ogg|quicktime)/.test(t)) return 'probably';
    if (/video\//.test(t)) return 'maybe';
    return '';
  };
}
