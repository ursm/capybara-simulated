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

function resolveVideoBytes(src) {
  if (!src) return '';
  if (src.startsWith('blob:')) {
    // Fragment is not part of the blob resource identity (matches resolveBlobBytes).
    const key = src.split('#')[0];
    const blob = globalThis.__csimBlobs && globalThis.__csimBlobs.get(key);
    if (blob) return blobBytes(blob);
    if (typeof globalThis.__csim_blobResolve === 'function') {
      const b64 = globalThis.__csim_blobResolve(key);
      if (b64) {
        try { return globalThis.atob(String(b64)); } catch (_) {}
      }
    }
  }
  return '';
}

function decodeAndDispatch(video, src) {
  const bytes = resolveVideoBytes(src);
  if (!bytes) {
    queueMicrotask(() => dispatchVideoEvent(video, 'error'));
    return;
  }
  // Bytes are small enough (the test fixture is 1.9 KB; the upload
  // pipeline caps at site-setting `max_image_size_kb`) that a single
  // host-fn b64 is cheaper than two host-fn round-trips for stash+
  // call. Switch to stashTransfer if a future workload pushes 100 MB+.
  const decoded = globalThis.__csim_decodeVideoFrame(globalThis.btoa(bytes));
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
    try { video.dispatchEvent(ev); } catch (_) {}
  }
  const handler = video['on' + type];
  if (typeof handler === 'function') {
    try { handler.call(video, ev); } catch (_) {}
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
