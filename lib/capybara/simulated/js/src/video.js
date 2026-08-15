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
    // The host now returns {b64, tainted}; this legacy fallback only needs bytes.
    const r = globalThis.__csim_videoBytesB64(src);
    if (r && typeof r === 'object') return r.b64 ? String(r.b64) : null;
    return r ? String(r) : null;
  }
  return null;
}

// A failed load/decode discards the PREVIOUS resource: the old frame must not
// stay drawable (its taint verdict no longer applies), matching the media load
// algorithm's dedicated-failure steps.
function failLoad(video) {
  video._csimVideoFrame      = null;
  video._csimVideoReadyState = 0;   // HAVE_NOTHING
  queueMicrotask(() => dispatchVideoEvent(video, 'error'));
}

function decodeAndDispatch(video, src) {
  // Frame-correct absolute URL (the raw attribute resolved against the MAIN
  // document host-side — the recurring wrong-base class), and a CONTROLLED
  // document's video bytes fetch through its service worker (destination
  // 'video') before the plain host fetch.
  let abs = src;
  try { abs = new globalThis.URL(src, video.baseURI || (globalThis.location && globalThis.location.href) || undefined).href; } catch (_) {}
  let b64 = null;
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
      if (sw.body_b64 == null || sw.body_b64 === '') { failLoad(video); return; }
      b64 = sw.body_b64;
      // Canvas origin-clean: an OPAQUE (no-cors cross-origin-derived) response's
      // frames taint a canvas they're drawn into; a cors/basic one is clean.
      tainted = sw.type === 'opaque';
    }
  }
  if (b64 == null) {
    if (/^https?:/i.test(abs)) {
      // The network leg runs the same CORS/taint verdict as the <img> host loader:
      // {b64, tainted}, or null for a failed load (incl. a cors-mode ACAO refusal).
      const r = typeof globalThis.__csim_videoBytesB64 === 'function'
        ? globalThis.__csim_videoBytesB64(abs, cors, credentials, (globalThis.location && globalThis.location.href) || '')
        : null;
      if (r && typeof r === 'object') { b64 = r.b64 ? String(r.b64) : null; tainted = !!r.tainted; }
      else b64 = r ? String(r) : null;
    } else {
      b64 = videoBytesB64(src);   // blob:/data: — same-origin-ish, never taints
    }
  }
  if (!b64) { failLoad(video); return; }
  const decoded = globalThis.__csim_decodeVideoFrame(b64);
  if (!decoded) { failLoad(video); return; }
  video._tainted           = tainted;
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
