// The 2D canvas: an RGBA bitmap (`canvas._pixels`, the page's own Uint8ClampedArray) and the CanvasRenderingContext2D,
// OffscreenCanvas, ImageData, ImageBitmap, CanvasGradient, CanvasPattern and Path2D surfaces over it. What a drawing
// operation does to the bitmap — its shape's coverage, its paint, the compositing operator, the clip, the shadow, the
// colour space — is native's (canvas.rs: `__dom.canvasDraw`), as are the paths it builds (canvas_path.rs) and the
// image file a bitmap is written as (image_encode.rs); this side keeps the drawing state, converts the arguments and
// hands each operation over. An image's bytes decode natively too (image_decode.rs), and a line of text is shaped and
// drawn to a coverage mask natively (text.rs).

import { latin1ToBytes }                                               from './bytes.js';
import { blobBytes }                                                   from './blob.js';
import { serializeAlpha } from './css-utils.js';
import { fontHandleFor }                                               from './font-metrics.js';

// An ImageData / getImageData region wider than this many bytes can't be backed;
// browsers throw a TypeError. We check BEFORE the eager Uint8ClampedArray
// allocation, which for an absurd size (e.g. a 2³¹-pixel getImageData) would
// OOM-abort the V8 isolate rather than throw a catchable error.
const MAX_IMAGE_BYTES = 0xFFFFFFFF;   // ~4.29 GB
function assertImageArea(w, h) {
  if (Math.abs(w) * Math.abs(h) * 4 > MAX_IMAGE_BYTES) {
    throw new globalThis.TypeError('canvas image data is too large to allocate');
  }
}

export class ImageData {
  // Two constructor forms per spec:
  //   new ImageData(sw, sh [, settings])                  — a blank buffer
  //   new ImageData(data, sw [, sh [, settings]])         — wrap existing pixels
  // A first argument that is an object but NOT a Uint8ClampedArray (e.g. a
  // Uint8Array) fails overload resolution → TypeError; the size/length invariants
  // throw IndexSizeError / InvalidStateError as the spec's construction steps do.
  constructor(a, b, c, d) {
    if (a instanceof globalThis.Uint8ClampedArray) {
      // form2: (data, sw, [sh], [settings]) — sw is required.
      if (b === undefined) throw new globalThis.TypeError('ImageData: the source width is required');
      const data = a;
      if (data.length === 0 || data.length % 4 !== 0) {
        throw new globalThis.DOMException('ImageData data length must be a non-zero multiple of 4', 'InvalidStateError');
      }
      const sw = b >>> 0;
      if (sw === 0) throw new globalThis.DOMException('ImageData source width is zero', 'IndexSizeError');
      const rows = data.length / 4;
      if (rows % sw !== 0) throw new globalThis.DOMException('ImageData data length is not a multiple of (4 × width)', 'IndexSizeError');
      const sh = c == null ? rows / sw : (c >>> 0);
      if (data.length !== sw * sh * 4) throw new globalThis.DOMException('ImageData data length does not match the given dimensions', 'IndexSizeError');
      this._data   = data;
      this._width  = sw;
      this._height = sh;
      this._colorSpace  = imageDataColorSpace(d);
      this._pixelFormat = imageDataPixelFormat(d);
    } else {
      // form1: (sw, sh, [settings]) — both dimensions required. A non-Uint8Clamped
      // Array OBJECT first argument with a third argument present is the data-form
      // arity with the wrong data type → TypeError; with only (obj, sw) it stays on
      // this numeric overload, where the object coerces to 0 → IndexSizeError.
      if ((a === null || typeof a === 'object') && c !== undefined) {
        throw new globalThis.TypeError('ImageData: the pixel array must be a Uint8ClampedArray');
      }
      if (b === undefined) throw new globalThis.TypeError('ImageData: the height is required');
      const sw = a >>> 0, sh = b >>> 0;
      if (sw === 0 || sh === 0) throw new globalThis.DOMException('ImageData dimensions must be non-zero', 'IndexSizeError');
      if (sw * sh * 4 > MAX_IMAGE_BYTES) throw new globalThis.DOMException('ImageData dimensions are too large', 'IndexSizeError');
      this._width  = sw;
      this._height = sh;
      this._data   = new globalThis.Uint8ClampedArray(sw * sh * 4);
      this._colorSpace  = imageDataColorSpace(c);
      this._pixelFormat = imageDataPixelFormat(c);
    }
  }
  // All four members are readonly IDL attributes — assigning is a no-op.
  get width()       { return this._width; }
  get height()      { return this._height; }
  get data()        { return this._data; }
  get colorSpace()  { return this._colorSpace; }
  get pixelFormat() { return this._pixelFormat; }
  get [globalThis.Symbol.toStringTag]() { return 'ImageData'; }
}

// ImageDataSettings.colorSpace / .pixelFormat — the predefined-colour-space and
// image-data-pixel-format enums, defaulting to sRGB unorm8.
function imageDataColorSpace(settings) {
  return settings && settings.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
}
function imageDataPixelFormat(settings) {
  return settings && settings.pixelFormat === 'rgba-float16' ? 'rgba-float16' : 'rgba-unorm8';
}

// An RGBA buffer converted IN PLACE from one canvas colour space to the other (`__dom.canvasConvert`: sRGB and Display
// P3, a wide colour clipped into sRGB as a browser reads one back) — a no-op where they match. Returns the buffer.
function convertColorSpace(data, from, to) {
  if (from !== to) globalThis.__dom.canvasConvert(data, from === 'display-p3', to === 'display-p3');
  return data;
}
// The colour space a drawImage source's pixels are in: a decoded image / bitmap
// carries `_colorSpace`; a <canvas> source is in its 2D context's colour space
// (its backing holds context-space values); anything else defaults to sRGB.
function sourceColorSpace(source) {
  if (source && source._colorSpace) return source._colorSpace;
  const ctx = source && source._ctx;
  if (ctx && ctx._attrs && ctx._attrs.colorSpace) return ctx._attrs.colorSpace;
  return 'srgb';
}

// Decoded pixel buffer. Constructed via `createImageBitmap(blob)` or
// `OffscreenCanvas.transferToImageBitmap`.
export class ImageBitmap {
  constructor() {
    this.width   = 0;
    this.height  = 0;
    this._pixels = null;   // Uint8ClampedArray, RGBA row-major
    this._closed = false;  // [[Detached]] — a closed bitmap is an unusable image source
  }
  close() { this._pixels = null; this._pixelsP3 = null; this.width = this.height = 0; this._closed = true; }
  get [Symbol.toStringTag]() { return 'ImageBitmap'; }
}

// Walks an arg to `drawImage` and returns `{pixels, width, height}`
// for the source. HTMLImageElement / Image with a loaded blob URL
// populates `_pixels` on `src=` assignment; ImageBitmap already
// carries them; canvases expose their own backing buffer.
// A <canvas> / OffscreenCanvas source: `getContext('2d')` yields a 2D context. A non-canvas
// element also has `getContext` (on the shared prototype) but it returns null there, so this
// is the reliable brand check (createImageBitmap of a non-canvas element must reject).
function isCanvasSource(src) {
  if (!src || typeof src.getContext !== 'function') return false;
  try { return !!src.getContext('2d'); } catch (_) { return false; }
}

// Whether `src` is a CanvasImageSource TYPE at all (img / canvas / video / ImageBitmap
// / VideoFrame) — regardless of whether it currently has usable pixels. drawImage of a
// recognized-but-unusable source (broken img) is a silent no-op; anything else (a <p>,
// a plain object) is a TypeError.
function isImageSourceType(src) {
  if (!src || typeof src !== 'object') return false;
  const tag = src._tag;
  if (tag === 'img' || tag === 'video' || tag === 'image') return true;   // 'image' = SVG <image>
  if (typeof src.getContext === 'function') return true;                  // HTMLCanvasElement / OffscreenCanvas
  return (globalThis.ImageBitmap && src instanceof globalThis.ImageBitmap) ||
         (globalThis.VideoFrame && src instanceof globalThis.VideoFrame) || false;
}

function resolveImagePixels(src) {
  if (!src) return null;
  // An <img>'s bitmap is its intrinsic (natural) size — independent of any
  // width/height content attribute, which only affects layout. Other sources
  // (canvas / ImageBitmap) size their buffer by width/height directly.
  if (src._pixels) {
    const w = src._naturalWidth != null ? src._naturalWidth : src.width;
    const h = src._naturalHeight != null ? src._naturalHeight : src.height;
    if (w && h) return {pixels: src._pixels, width: w, height: h};
  }
  // HTMLVideoElement's first-decoded frame is cached the same shape.
  const f = src._csimVideoFrame;
  if (f && f._pixels && f.width && f.height) return {pixels: f._pixels, width: f.width, height: f.height};
  return null;
}

// Whether drawing / patterning from `src` taints the destination canvas (clears its origin-clean
// flag): a cross-origin image whose bytes aren't CORS-approved (`_tainted`, set by the image
// load), an ImageBitmap carrying that taint, or a <canvas>/OffscreenCanvas whose OWN context is
// already tainted (taint is transitive). A same-origin / CORS-approved / data: source is clean.
// A <video>'s `_tainted` is set by its fetch (opaque SW response / no-cors cross-origin
// network load — video.js decodeAndDispatch), same model as <img>.
function imageSourceTainted(src) {
  if (!src || typeof src !== 'object') return false;
  if (src._tainted) return true;                                   // <img> / SVG <image> / ImageBitmap
  if (typeof src.getContext === 'function') {                      // <canvas> / OffscreenCanvas
    try { const c = src.getContext('2d'); return !!(c && c._originClean === false); } catch (_) {}
  }
  return false;
}

// Whether canvas `c`'s backing store is tainted — its 2D context's origin-clean flag is false.
// A canvas that never got a 2D context can't have been drawn to, so it's clean.
function canvasTainted(c) {
  return !!(c && c._ctx && c._ctx._originClean === false);
}

// RGBA blit (`__dom.canvasBlit`): the `sw` × `sh` rectangle at (sx, sy) of `src` (`srcW` × `srcH`) copied over (dx,
// dy) of `dst` (`dstW` × `dstH`), scaled to `dw` × `dh` nearest-neighbour, what falls outside either left alone —
// what getImageData, putImageData and createImageBitmap's crop and resize move.
function blitRGBA(src, srcW, srcH, sx, sy, sw, sh, dst, dstW, dstH, dx, dy, dw, dh) {
  globalThis.__dom.canvasBlit(src, dst, new globalThis.Float64Array([srcW, srcH, sx, sy, sw, sh, dstW, dstH, dx, dy, dw, dh]));
}

// Parse a CSS colour to `{r, g, b, a}` — bytes clamped into sRGB, `a` in 0..1 — or null when it is no colour (an
// invalid `fillStyle` / `strokeStyle` assignment is ignored, per spec). The style engine parses and resolves it
// (`__dom.cssColor`): `currentColor`, top level or nested in a `color-mix()` or a relative colour, is `cc`. A colour
// written in a CSS Color 4 form (`color()`, `lab()`, `oklch()`, a mix) also carries `css`, its serialization, which is
// what reads back from a style it was set on; a legacy sRGB one reads back as a canvas writes it (hex, `rgba()`).
function parseColorRGBA(str, cc) {
  if (typeof str !== 'string') return null;
  const c = globalThis.__dom.cssColor(str, cc || 'black');
  if (c === null) return null;
  const byte = (x) => Math.round(clamp01(x) * 255);
  const color = {r: byte(c[0]), g: byte(c[1]), b: byte(c[2]), a: clamp01(c[3])};
  if (!c[4]) color.css = c[5];
  return color;
}

// True when every argument is a finite number (the geometry / transform methods
// no-op on a non-finite coordinate per the canvas spec). `isFinite` reads only
// its first argument, so `every`'s (element, index, array) callback is safe here.
function allFinite(...xs) { return xs.every(isFinite); }

// WebIDL "not enough arguments" — a canvas method with fewer than its required
// argument count throws a TypeError before doing anything.
function argc(len, n) {
  if (len < n) throw new globalThis.TypeError(`${n} argument${n === 1 ? '' : 's'} required, but only ${len} present.`);
}

// WebIDL `[EnforceRange] long` coercion for the ImageData geometry APIs: a
// non-finite argument (Infinity / NaN) is a TypeError; otherwise truncate toward
// zero. (createImageData / getImageData / putImageData all reject non-finite
// coordinates rather than silently flooring them to 0.)
function enforceLong(v) {
  const n = Number(v);
  if (!isFinite(n)) throw new globalThis.TypeError('Value is not a finite number');
  return Math.trunc(n);
}

// Clamp to the 0..1 alpha range.
function clamp01(a) { return a < 0 ? 0 : a > 1 ? 1 : a; }

// The pen's caps and joins, by the codes the rasterizer reads them as.
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

// measureText cache keyed by face, size, kerning and text — the metrics depend only on those, not the context state,
// so it is shared across contexts.
const measureCache = new globalThis.Map();

// Plain-value drawing-state fields snapshotted by save() / restore() (the object-
// valued ones — transform, styles, clip, dash — are handled explicitly).
const STATE_KEYS = [
  'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality',
  '_fontParts', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing',
  'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'lang', 'filter',
  'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
];

// Enum keyword sets for the text drawing-state IDL attributes. A setter ignores any
// value not in its set (keeps the previous), per spec — no case-folding or trimming, so
// 'END', 'end ' and 'end\0' are all invalid.
const TEXT_ALIGNS     = new Set(['start', 'end', 'left', 'right', 'center']);
const TEXT_BASELINES  = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'];   // the IDL's order, which canvasText takes
const TEXT_DIRECTIONS = new Set(['ltr', 'rtl', 'inherit']);
// The canvas text-preparation algorithm replaces every tab / line-feed / form-feed /
// carriage-return with a space (canvas text is a single line), before spacing and
// rendering.
const CANVAS_TEXT_WS = /[\t\n\f\r]/g;
const FONT_VARIANT_CAPS = new Set(['normal', 'small-caps', 'all-small-caps', 'petite-caps',
  'all-petite-caps', 'unicase', 'titling-caps']);
const TEXT_RENDERINGS   = new Set(['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision']);
const FONT_KERNINGS     = new Set(['auto', 'normal', 'none']);

const FONT_STRETCH_KW = new Set(['ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded']);
const FONT_SYSTEM_KW  = new Set(['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);

// The canvas "serialize a colour": a Color-4 result keeps its canonical
// `color(srgb …)` form; otherwise an opaque colour → lowercase `#rrggbb`, a
// translucent one → `rgba(r, g, b, a)` — what `ctx.fillStyle` reads back. The
// alpha is the canvas's BYTE, so opaque is what rounds to 255 and the rest is the
// shortest decimal of that byte (Chrome and Firefox: `rgba(…, 0.999)` is `#…`,
// `#ff000080` is `rgba(255, 0, 0, 0.5)`, `rgba(…, 0.123456)` is `0.12`).
function serializeCanvasColor(c) {
  if (c.css) return c.css;
  const alpha = Math.round(c.a * 255);
  if (alpha >= 255) {
    const hx = n => n.toString(16).padStart(2, '0');
    return '#' + hx(c.r) + hx(c.g) + hx(c.b);
  }
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${serializeAlpha(alpha / 255)})`;
}

// Every valid globalCompositeOperation value (the setter ignores anything else). The non-separable blend modes
// (hue/saturation/color/luminosity) composite as source-over (canvas.rs `Op`).
const KNOWN_GCO = new globalThis.Set([
  'source-over', 'source-in', 'source-out', 'source-atop',
  'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'copy', 'xor', 'lighter', 'plus-lighter', 'clear',
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

// Multiply two 2D affine matrices `[a, b, c, d, e, f]` (A then B applied to the
// point — i.e. append B to A, matching canvas `transform()` post-multiply).
function mulMatrix(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

// The 2D components [a,b,c,d,e,f] of a DOMMatrix2DInit (a DOMMatrix instance or a
// plain a–f / m11–m42 dict). Runs the spec DOMMatrix validation via DOMMatrix — a
// dict whose a and m11 (etc.) disagree is a TypeError. Values may be non-finite; the
// caller decides whether that's a no-op (setTransform) — hence the finite check here.
function matrix2DInit(t) {
  const m = globalThis.DOMMatrix.fromMatrix(t);
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

// Largest bitmap we densely materialize in-process (RGBA), ≈512 MB. A createImageBitmap
// crop / resize that would exceed this can't be backed by a real buffer, so it's rejected
// with InvalidStateError — a browser would likewise hit its max-texture limit.
const MAX_BITMAP_AREA = 2 ** 27;

// `createImageBitmap(image[, sx, sy, sw, sh][, options])` — async factory. Resolves the
// source to an RGBA buffer (decoding a Blob, snapshotting a canvas / image /
// ImageBitmap / ImageData), applies the optional crop rectangle then resize, and returns
// a Promise<ImageBitmap>. Rejection contract (per the HTML spec, in this order): a given
// sw/sh of 0 → RangeError; a resizeWidth/resizeHeight of 0 → InvalidStateError; a
// recognized-but-unusable source (empty / broken image, zero-area or oversized canvas,
// closed ImageBitmap, undecodable Blob) → InvalidStateError; anything that isn't an image
// source at all → TypeError.
export function createImageBitmap(source, optionsOrSx, sy, sw, sh, opts) {
  const cropForm = typeof optionsOrSx === 'number';
  const options  = (cropForm ? opts : optionsOrSx) || {};
  // The crop rectangle args are WebIDL `long` (ToInt32): 4294967400 → 104, 4294967295
  // → -1. Coercing here is what keeps "very large" crop dimensions from ballooning into
  // an unallocatable buffer (they wrap to small ints); a genuinely oversized rect only
  // arises from an actual resize, guarded by MAX_BITMAP_AREA below.
  const csx = cropForm ? (optionsOrSx | 0) : 0;
  const csy = cropForm ? (sy | 0) : 0;
  const csw = cropForm ? (sw | 0) : 0;
  const csh = cropForm ? (sh | 0) : 0;
  // resizeWidth / resizeHeight are WebIDL `unsigned long` (ToUint32); 0.5 truncates to 0.
  const rw = options.resizeWidth, rh = options.resizeHeight;
  const hasRW = rw !== undefined && rw !== null;
  const hasRH = rh !== undefined && rh !== null;
  const rwU = rw >>> 0, rhU = rh >>> 0;
  // imageOrientation, an ImageOrientation enum: "from-image" (the default) or "flipY" — `none` is none of them now (the
  // spec renamed it from-image), and a value that is no member a TypeError. flipY flips the image as stored,
  // "disregarding any image orientation metadata of the source (such as EXIF metadata)".
  const orientation = options.imageOrientation === undefined ? 'from-image' : `${options.imageOrientation}`;
  const flipY = orientation === 'flipY';
  return new Promise((resolve, reject) => {
    const invalid = () => reject(new globalThis.DOMException('the image argument is not usable', 'InvalidStateError'));
    const typeErr = () => reject(new globalThis.TypeError('createImageBitmap: unsupported image source'));
    if (orientation !== 'from-image' && !flipY) return reject(new globalThis.TypeError(`createImageBitmap: '${orientation}' is no ImageOrientation`));

    // Step 1: a supplied sw or sh of 0 is a RangeError — checked before source usability.
    if (cropForm && (csw === 0 || csh === 0)) {
      return reject(new globalThis.RangeError('createImageBitmap: the crop rect width and height must be non-zero'));
    }
    // Step 2: a resizeWidth / resizeHeight present and 0 → InvalidStateError.
    if ((hasRW && rwU < 1) || (hasRH && rhU < 1)) return invalid();

    // Apply crop (if requested) then resize then flipY, and resolve. Crop / resize reuse
    // the shared `blitRGBA` primitive (out-of-bounds → transparent black, NN downscale,
    // fast identity row-copy) blitting the source straight into a fresh output — no full-
    // source intermediate copy. An output larger than we can densely materialize
    // (MAX_BITMAP_AREA) — e.g. a resize scaled up to billions of pixels — is reported as
    // InvalidStateError, matching browsers' internal-failure behaviour (their max-texture
    // limit). `ownsBuffer` is true when `px` is already a private buffer (a freshly
    // decoded Blob) the bitmap may take as-is; a live source buffer is copied only when no
    // transform already produced a fresh one, so the bitmap never aliases live pixels.
    const finish = (px, w, h, ownsBuffer, colorSpace, p3Pixels) => {
      try {
        let out = px, ow = w, oh = h, fresh = false;
        if (cropForm) {
          let sx = csx, sy = csy, sw = csw, sh = csh;
          if (sw < 0) { sx += sw; sw = -sw; }   // a negative dimension repositions the rect
          if (sh < 0) { sy += sh; sh = -sh; }   // (does not mirror content); normalize first
          if (sw * sh > MAX_BITMAP_AREA) return invalid();
          const dst = new globalThis.Uint8ClampedArray(sw * sh * 4);
          blitRGBA(out, ow, oh, sx, sy, sw, sh, dst, sw, sh, 0, 0, sw, sh);
          out = dst; ow = sw; oh = sh; fresh = true;
        }
        let tw = hasRW ? rwU : 0, th = hasRH ? rhU : 0;
        if (hasRW && !hasRH) th = Math.max(1, Math.round(oh * tw / ow));   // one dimension → preserve aspect ratio
        else if (hasRH && !hasRW) tw = Math.max(1, Math.round(ow * th / oh));
        if ((hasRW || hasRH) && (tw !== ow || th !== oh)) {
          if (tw * th > MAX_BITMAP_AREA) return invalid();
          const dst = new globalThis.Uint8ClampedArray(tw * th * 4);
          blitRGBA(out, ow, oh, 0, 0, ow, oh, dst, tw, th, 0, 0, tw, th);
          out = dst; ow = tw; oh = th; fresh = true;
        }
        // `imageOrientation: 'flipY'` mirrors the bitmap top-to-bottom — the image as
        // stored, turned back above. 'from-image' (the default) keeps it as decoded,
        // which is already turned as its EXIF orientation says (image_decode.rs).
        if (flipY) {
          const flipped = new globalThis.Uint8ClampedArray(ow * oh * 4);
          const rowBytes = ow * 4;
          for (let y = 0; y < oh; y++) flipped.set(out.subarray((oh - 1 - y) * rowBytes, (oh - y) * rowBytes), y * rowBytes);
          out = flipped; fresh = true;
        }
        if (!fresh && !ownsBuffer) out = new globalThis.Uint8ClampedArray(out);   // bitmap must own its pixels
        const bm = new ImageBitmap();
        bm._pixels = out; bm.width = ow; bm.height = oh;
        // A bitmap decoded from a tainted source (a cross-origin <img>/<canvas>/ImageBitmap) stays
        // tainted, so it can't launder cross-origin pixels clean back into a canvas.
        bm._tainted = imageSourceTainted(source);
        // `colorSpaceConversion: 'none'` means don't colour-manage the source: treat
        // the decoded bytes as unmanaged (sRGB, no conversion downstream). Otherwise
        // preserve the source's colour space so a later drawImage converts correctly.
        bm._colorSpace = options.colorSpaceConversion === 'none' ? 'srgb' : (colorSpace || sourceColorSpace(source));
        // Carry the wide-gamut (Display-P3) rendering of a wide-profile source, but
        // only for an untransformed bitmap (crop/resize/flip would have to re-derive
        // it too, which isn't modeled — those fall back to the sRGB rendering).
        if (p3Pixels && !fresh && options.colorSpaceConversion !== 'none') bm._pixelsP3 = p3Pixels;
        resolve(bm);
      } catch (_) {
        invalid();
      }
    };

    if (source instanceof globalThis.Blob) {
      const bytes = blobBytes(source);
      if (!bytes) return invalid();
      // A plain Blob (no crop) is shrunk as it decodes (`__dom.decodeImage`'s fit); the crop
      // form decodes at natural size and crops/resizes via blitRGBA.
      const decoded = globalThis.__dom.decodeImage(
        latin1ToBytes(bytes), cropForm || flipY ? 0 : (hasRW ? rwU : 0), cropForm || flipY ? 0 : (hasRH ? rhU : 0));
      if (!decoded || !decoded.pixels) return invalid();
      if (flipY && decoded.orientation > 1) return finish(...unturned(decoded.pixels, decoded.width, decoded.height, decoded.orientation), true, decoded.colorSpace);
      // The decoded buffer is private (and a non-crop Blob is already resized, so finish()'s
      // resize is a no-op there — dims match).
      return finish(decoded.pixels, decoded.width, decoded.height, true, decoded.colorSpace, decoded.pixelsP3 || null);
    }
    if (source instanceof ImageData) {
      return finish(source.data, source.width, source.height, false, source.colorSpace);
    }
    if (source instanceof ImageBitmap) {
      if (source._closed || !source._pixels) return invalid();
      return finish(source._pixels, source.width, source.height, false, undefined, source._pixelsP3);
    }
    if (isCanvasSource(source)) {
      // A <canvas> / OffscreenCanvas: zero-area is unusable; snapshot its backing buffer
      // (transparent black when nothing has been drawn). An oversized canvas' zero-fill
      // allocation throws → InvalidStateError.
      const w = source.width | 0, h = source.height | 0;
      if (w <= 0 || h <= 0) return invalid();
      if (source._pixels) return finish(source._pixels, w, h, false);
      let zero;
      try { zero = new globalThis.Uint8ClampedArray(w * h * 4); } catch (_) { return invalid(); }
      return finish(zero, w, h, true);
    }
    if (isImageSourceType(source)) {
      // A recognized image / video element with no usable pixels (not yet loaded, broken,
      // or zero intrinsic size) is a usability failure — InvalidStateError, not TypeError.
      const ip = resolveImagePixels(source);
      if (!ip || !ip.width || !ip.height) return invalid();
      if (flipY && source._orientation > 1) return finish(...unturned(ip.pixels, ip.width, ip.height, source._orientation), true);
      return finish(ip.pixels, ip.width, ip.height, false, undefined, source._pixelsP3);
    }
    return typeErr();
  });
}

// A decoded image's pixels as they were before its EXIF `orientation` turned them (`imageOrientation: 'flipY'`, which
// disregards it): `[pixels, width, height]`. The Display P3 rendering is not turned back, so it is not carried.
function unturned(pixels, width, height, orientation) {
  const r = globalThis.__dom.unorientImage(pixels, width, height, orientation);
  return [r.pixels, r.width, r.height];
}

// A linear, radial or conic gradient set as a fill/stroke style, its colour stops kept sorted by offset (stable for
// equal offsets).
export class CanvasGradient {
  constructor(kind, coords) { this._kind = kind; this._c = coords; this._stops = []; }

  addColorStop(offset, color) {
    argc(arguments.length, 2);   // both offset and color are required
    offset = +offset;
    // The offset is a (restricted) double: non-finite is a TypeError; a finite value
    // outside [0, 1] is an IndexSizeError.
    if (!isFinite(offset)) throw new globalThis.TypeError('addColorStop: offset must be finite');
    if (offset < 0 || offset > 1) throw new globalThis.DOMException('offset out of [0,1]', 'IndexSizeError');
    // A gradient isn't associated with an element, so a `currentColor` stop resolves to
    // the initial colour, opaque black — not the canvas element's `color`.
    const col = parseColorRGBA(String(color).trim().toLowerCase() === 'currentcolor' ? 'black' : color);
    if (!col) throw new globalThis.DOMException('invalid color', 'SyntaxError');
    let i = this._stops.length;                       // insert keeping offsets sorted,
    while (i > 0 && this._stops[i - 1].offset > offset) i--;   // stable for equal offsets
    this._stops.splice(i, 0, {offset, color: col});
  }

  get [Symbol.toStringTag]() { return 'CanvasGradient'; }

  // The gradient as the rasterizer takes it (`__dom.canvasDraw`'s paint): its kind and geometry, then its stops.
  _paint() {
    const c = this._c;
    const head = this._kind === 'linear' ? [2, c.x0, c.y0, c.x1, c.y1]
               : this._kind === 'radial' ? [3, c.x0, c.y0, c.r0, c.x1, c.y1, c.r1]
               : [4, c.a0, c.x, c.y];
    head.push(this._stops.length);
    for (const {offset, color} of this._stops) head.push(offset, color.r, color.g, color.b, color.a);
    return new globalThis.Float64Array(head);
  }
}

// The valid createPattern repetition keywords.
const PATTERN_REPS = new globalThis.Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat']);

// A tiled-image fill/stroke style (createPattern). Holds a snapshot of the source
// image's RGBA pixels + the repetition mode + an optional pattern-space transform.
export class CanvasPattern {
  constructor(pixels, w, h, repetition, colorSpace) {
    this._px = pixels; this._w = w; this._h = h; this._rep = repetition;
    this._colorSpace = colorSpace || 'srgb';   // source pixels' colour space (for the fill conversion)
    this._m = [1, 0, 0, 1, 0, 0];   // pattern-space transform (setTransform)
  }
  get [Symbol.toStringTag]() { return 'CanvasPattern'; }

  // setTransform(DOMMatrix2DInit) — the pattern is sampled in a space transformed
  // by this matrix (a DOMMatrix or an a–f / m11–m42 dict). A non-finite matrix is a
  // no-op (leaves the current transform); an inconsistent dict is a TypeError.
  setTransform(t) {
    if (t == null) return;
    const m = matrix2DInit(t);
    if (m.every(isFinite)) this._m = m;
  }

  // The pattern as the rasterizer takes it (`__dom.canvasDraw`'s paint): its tile's size, the axes it repeats on, its
  // colour space and its transform; the tile's pixels go beside it.
  _paint() {
    const rep = this._rep;
    return new globalThis.Float64Array([5, this._w, this._h, +(rep === 'repeat' || rep === 'repeat-x'),
      +(rep === 'repeat' || rep === 'repeat-y'), +(this._colorSpace === 'display-p3'), ...this._m]);
  }
}

// The path-building surface (the CanvasPath IDL mixin) shared by the context's current default path and by Path2D:
// the arguments converted as WebIDL converts them, then handed to native (canvas_path.rs `Builder`), which keeps the
// path in `_buf` — its subpaths and current point, curves and arcs flattened on the way in — and writes it in place,
// handing back a bigger array where it outgrows this one. `ctmFn`, when given (the context's default path), is the
// CTM each point is baked through as it is added: a later transform does not move a point already in the path. A
// Path2D has none and keeps user-space points, which the consuming context's CTM maps when it paints.
const PATH_OP = {moveTo: 0, lineTo: 1, closePath: 2, rect: 3, roundRect: 4, bezierCurveTo: 5, quadraticCurveTo: 6,
                 arc: 7, ellipse: 8, arcTo: 9, reset: 10};
const IDENTITY = [1, 0, 0, 1, 0, 0];

export class CanvasPath {
  constructor(ctmFn) {
    this._ctmFn = ctmFn || null;
    this._buf = null;
    this.reset();
  }
  get _baked() { return this._ctmFn != null; }
  get _empty() { return globalThis.__dom.canvasPathEmpty(this._buf); }
  _took(r) {
    if (Array.isArray(r)) throw r[0] === 'RangeError' ? new globalThis.RangeError(r[1]) : new globalThis.DOMException(r[1], r[0]);
    if (r) this._buf = r;
  }
  _op(op, a, b, c, d, e, f, g, h) {
    const m = this._ctmFn ? this._ctmFn() : IDENTITY;
    this._took(globalThis.__dom.canvasPath(this._buf, op, this._ctmFn != null, m[0], m[1], m[2], m[3], m[4], m[5], a, b, c, d, e, f, g, h));
  }
  reset() { this._op(PATH_OP.reset); }

  // The path-building methods carry their own WebIDL arity check so a DIRECT Path2D call (which doesn't go through
  // the context's delegators) also throws on too few arguments.
  moveTo(x, y) { argc(arguments.length, 2); this._op(PATH_OP.moveTo, +x, +y); }
  lineTo(x, y) { argc(arguments.length, 2); this._op(PATH_OP.lineTo, +x, +y); }
  closePath() { this._op(PATH_OP.closePath); }
  rect(x, y, w, h) { argc(arguments.length, 4); this._op(PATH_OP.rect, +x, +y, +w, +h); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    argc(arguments.length, 6);
    this._op(PATH_OP.bezierCurveTo, +c1x, +c1y, +c2x, +c2y, +x, +y);
  }
  quadraticCurveTo(cx, cy, x, y) { argc(arguments.length, 4); this._op(PATH_OP.quadraticCurveTo, +cx, +cy, +x, +y); }
  arc(x, y, r, a0, a1, ccw) { argc(arguments.length, 5); this._op(PATH_OP.arc, +x, +y, +r, +a0, +a1, +!!ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    argc(arguments.length, 7);
    this._op(PATH_OP.ellipse, +x, +y, +rx, +ry, +rot, +a0, +a1, +!!ccw);
  }
  arcTo(x1, y1, x2, y2, r) { argc(arguments.length, 5); this._op(PATH_OP.arcTo, +x1, +y1, +x2, +y2, +r); }
  // `radii`: `(unrestricted double or DOMPointInit or sequence<(unrestricted double or DOMPointInit)>)`, told apart as
  // WebIDL tells a union: an object (a function too) with an `@@iterator` method a sequence, each element converted as
  // it is iterated; any other object, or null, a DOMPointInit; anything else a number.
  roundRect(x, y, w, h, radii = 0) {
    argc(arguments.length, 4);
    x = +x; y = +y; w = +w; h = +h;
    const isObject = radii !== null && (typeof radii === 'object' || typeof radii === 'function');
    const method = isObject ? radii[Symbol.iterator] : undefined;
    const flat = [];
    if (method == null) {
      flat.push(...radius(radii));
    } else {
      if (typeof method !== 'function') throw new globalThis.TypeError('roundRect: the radii are not iterable');
      for (const v of {[Symbol.iterator]: () => method.call(radii)}) flat.push(...radius(v));
    }
    const m = this._ctmFn ? this._ctmFn() : IDENTITY;
    this._took(globalThis.__dom.canvasPath(this._buf, PATH_OP.roundRect, this._ctmFn != null, ...m, x, y, w, h, ...flat));
  }
}
// A radius, `(unrestricted double or DOMPointInit)`: an object, or null or undefined, a DOMPointInit; else a number for
// both axes.
function radius(v) {
  return v == null || typeof v === 'object' || typeof v === 'function' ? pointInit(v) : [+v, +v];
}
// A DOMPointInit's x and y, its members (w, x, y, z) read and converted in order.
function pointInit(v) {
  const member = k => { const m = v?.[k]; return m === undefined ? 0 : +m; };
  member('w');
  const x = member('x'), y = member('y');
  member('z');
  return [x, y];
}

// A standalone path usable with fill(path) / stroke(path) / clip(path) / isPointInPath(path, …): built from the
// CanvasPath methods, copied from another Path2D, or read from SVG path data.
export class Path2D extends CanvasPath {
  constructor(arg) {
    super();
    if (arg instanceof CanvasPath) this._buf = arg._buf.slice();
    else if (arg !== undefined) this._took(globalThis.__dom.canvasPathSvg(this._buf, String(arg)));
  }
  get [Symbol.toStringTag]() { return 'Path2D'; }

  // Append another path's subpaths, optionally through a DOMMatrix2DInit transform.
  addPath(path, transform) {
    if (!(path instanceof CanvasPath)) return;
    this._took(globalThis.__dom.canvasPathAdd(this._buf, path._buf, transform ? matrix2DInit(transform) : null));
  }
}

// 2D rendering context: image blit + readback (drawImage / getImageData /
// putImageData) plus rectangle + arbitrary-path rasterization (fill / stroke /
// clip) through the current transform, with solid-colour and gradient paints,
// shadows, and compositing. A Path2D can be filled / stroked / clipped directly.
export class CanvasRenderingContext2D {
  // `canvas` is a readonly IDL attribute — assigning to it is a no-op (the
  // getter-only accessor ignores the write in non-strict code).
  get canvas() { return this._canvas; }

  constructor(canvas, options) {
    this._canvas = canvas;
    const o = options || {};
    this._attrs = {
      alpha:              o.alpha !== false,
      desynchronized:     !!o.desynchronized,
      colorSpace:         o.colorSpace || 'srgb',
      colorType:          o.colorType || 'unorm8',
      willReadFrequently: !!o.willReadFrequently,
    };
    this._rectScratch = new CanvasPath();
    this._resetState();
  }

  // Reset the full rendering state to defaults. Called at construction and when
  // the canvas is resized (setting width/height resets the context per spec):
  // transform, clip, styles, line params, and the current path all go back to
  // their initial values.
  _resetState() {
    // origin-clean: false once a cross-origin (non-CORS-approved) source has been drawn / patterned
    // in, which makes getImageData / toDataURL / toBlob throw SecurityError. Resetting it here is
    // correct: this runs at construction and on resize (a resized canvas is a fresh, clean bitmap),
    // but NOT on save()/restore() (taint is permanent for the life of the bitmap).
    this._originClean             = true;
    this.globalAlpha              = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled    = true;
    this.lineWidth                = 1;
    this.lineCap                  = 'butt';
    this.lineJoin                 = 'miter';
    this.miterLimit               = 10;
    this.lineDashOffset           = 0;
    this.font                     = '10px sans-serif';
    this.textAlign                = 'start';
    this.textBaseline             = 'alphabetic';
    this.direction                = 'inherit';
    this.letterSpacing            = '0px';
    this.wordSpacing              = '0px';
    this.fontKerning              = 'auto';
    this.fontStretch              = 'normal';
    this.fontVariantCaps          = 'normal';
    this.textRendering            = 'auto';
    this.lang                     = 'inherit';   // default per spec; 'inherit' → the canvas element's lang
    this.filter                   = 'none';
    this.imageSmoothingQuality    = 'low';
    // Shadow: all four attributes go through validating setters (private _shadow*
    // fields). shadowColor is parsed + serialized like fillStyle; the default is
    // fully-transparent black (no shadow).
    this.shadowBlur               = 0;
    this.shadowOffsetX            = 0;
    this.shadowOffsetY            = 0;
    this._shadow                  = {r: 0, g: 0, b: 0, a: 0};   // parsed shadowColor
    this._fill                    = {r: 0, g: 0, b: 0, a: 1};   // parsed fillStyle (solid)
    this._stroke                  = {r: 0, g: 0, b: 0, a: 1};   // parsed strokeStyle (solid)
    this._fillObj                 = null;                        // gradient fillStyle, if set
    this._strokeObj               = null;                        // gradient strokeStyle, if set
    this._clip                    = null;                        // clip mask (Uint8Array) or null
    this._lineDash                = [];
    this._m                       = [1, 0, 0, 1, 0, 0];         // current transform
    this._stack                   = [];                          // save()/restore() state
    this._pathObj                 = new CanvasPath(() => this._m);   // default path bakes the CTM per point
  }

  // fillStyle / strokeStyle: a CanvasGradient/Pattern is stored and read back as the
  // object; a valid CSS colour is stored parsed + read back in the canvas
  // serialization; an invalid value is ignored (spec's "otherwise, do nothing").
  get fillStyle() { return this._fillObj || serializeCanvasColor(this._fill); }
  set fillStyle(v) {
    const s = this._parseStyle(v);
    if (s === undefined) return;
    if (s instanceof CanvasGradient || s instanceof CanvasPattern) { this._fillObj = s; return; }
    this._fill = s; this._fillObj = null;
  }
  get strokeStyle() { return this._strokeObj || serializeCanvasColor(this._stroke); }
  set strokeStyle(v) {
    const s = this._parseStyle(v);
    if (s === undefined) return;
    if (s instanceof CanvasGradient || s instanceof CanvasPattern) { this._strokeObj = s; return; }
    this._stroke = s; this._strokeObj = null;
  }

  // Resolve a fillStyle / strokeStyle assignment to a gradient/pattern, a parsed
  // {r,g,b,a} colour, or `undefined` (invalid → keep the previous style). Accepts a
  // {r,g,b[,a]} colour object (components in [0,1]) and coerces anything else to a
  // string (its `toString`, which may throw — that propagates, per WebIDL).
  _parseStyle(v) {
    if (v instanceof CanvasGradient || v instanceof CanvasPattern) return v;
    if (v && typeof v === 'object' && typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number') {
      const c = x => Math.round(clamp01(+x || 0) * 255);   // `|| 0` folds a NaN component to 0
      return {r: c(v.r), g: c(v.g), b: c(v.b), a: v.a == null ? 1 : clamp01(+v.a || 0)};
    }
    return parseColorRGBA(String(v), this._currentColor()) || undefined;
  }
  get shadowColor() { return serializeCanvasColor(this._shadow); }
  set shadowColor(v) { const c = parseColorRGBA(String(v), this._currentColor()); if (c) this._shadow = c; }

  // The CSS `currentColor` value: the canvas element's computed `color` (a detached
  // canvas / OffscreenCanvas has no element, so it falls back to the initial black).
  // Passed to parseColorRGBA so `currentColor` — top-level or nested in color-mix() /
  // a relative colour — resolves at assignment time.
  _currentColor() {
    try {
      const el = this.canvas;
      if (el && el.isConnected && globalThis.getComputedStyle) {
        const col = globalThis.getComputedStyle(el).color;
        if (col) return col;
      }
    } catch (_) { /* fall through to the initial value */ }
    return 'black';
  }

  // Shadow geometry: per spec the setters IGNORE a value that is negative (blur
  // only) or non-finite, keeping the previous one — a raw Infinity would hang the
  // blur and a NaN would wipe the canvas.
  get shadowBlur() { return this._shadowBlur; }
  set shadowBlur(v) { v = +v; if (isFinite(v) && v >= 0) this._shadowBlur = v; }
  get shadowOffsetX() { return this._shadowOffsetX; }
  set shadowOffsetX(v) { v = +v; if (isFinite(v)) this._shadowOffsetX = v; }
  get shadowOffsetY() { return this._shadowOffsetY; }
  set shadowOffsetY(v) { v = +v; if (isFinite(v)) this._shadowOffsetY = v; }

  // Line-style IDL: the setters ignore an out-of-range value (keeping the previous),
  // per the CanvasPathDrawingStyles spec. lineWidth / miterLimit take a positive
  // finite number (zero, negative, Infinity, NaN ignored); lineCap / lineJoin take
  // one of their enum keywords (any other string, wrong case, trailing NUL ignored).
  get lineWidth()  { return this._lineWidth; }
  set lineWidth(v) { v = +v; if (isFinite(v) && v > 0) this._lineWidth = v; }
  get miterLimit()  { return this._miterLimit; }
  set miterLimit(v) { v = +v; if (isFinite(v) && v > 0) this._miterLimit = v; }
  get lineCap()  { return this._lineCap; }
  set lineCap(v) { if (v === 'butt' || v === 'round' || v === 'square') this._lineCap = v; }
  get lineJoin()  { return this._lineJoin; }
  set lineJoin(v) { if (v === 'round' || v === 'bevel' || v === 'miter') this._lineJoin = v; }
  get lineDashOffset()  { return this._lineDashOffset; }
  set lineDashOffset(v) { v = +v; if (isFinite(v)) this._lineDashOffset = v; }
  // Text drawing-state enums / lengths: each setter ignores an out-of-range value.
  get textAlign()  { return this._textAlign; }
  set textAlign(v) { if (TEXT_ALIGNS.has(v)) this._textAlign = v; }
  get textBaseline()  { return this._textBaseline; }
  set textBaseline(v) { if (TEXT_BASELINES.includes(v)) this._textBaseline = v; }
  get direction()  { return this._direction; }
  set direction(v) { if (TEXT_DIRECTIONS.has(v)) this._direction = v; }
  get fontStretch()  { return this._fontStretch; }
  set fontStretch(v) { if (v === 'normal' || FONT_STRETCH_KW.has(v)) this._fontStretch = v; }
  get fontVariantCaps()  { return this._fontVariantCaps; }
  set fontVariantCaps(v) { if (FONT_VARIANT_CAPS.has(v)) this._fontVariantCaps = v; }
  get textRendering()  { return this._textRendering; }
  set textRendering(v) { if (TEXT_RENDERINGS.has(v)) this._textRendering = v; }
  get fontKerning()  { return this._fontKerning; }
  set fontKerning(v) { if (FONT_KERNINGS.has(v)) this._fontKerning = v; }
  // letterSpacing / wordSpacing: a CSS <length> (`__dom.canvasSpacing`), read back serialized; anything else is
  // ignored.
  get letterSpacing()  { return this._letterSpacing; }
  set letterSpacing(v) { const p = globalThis.__dom.canvasSpacing(String(v), NaN, NaN); if (p) this._letterSpacing = p[0]; }
  get wordSpacing()  { return this._wordSpacing; }
  set wordSpacing(v) { const p = globalThis.__dom.canvasSpacing(String(v), NaN, NaN); if (p) this._wordSpacing = p[0]; }
  // font: on getting, the canonical serialized shorthand; on setting, parse-and-ignore
  // an unparsable value (keep the previous), resolving the size to px at assignment.
  get font()  { return this._fontParts[0]; }
  set font(v) { const f = this._computeFont(v); if (f) this._fontParts = f; }

  // globalAlpha: the setter ignores a value outside [0, 1] or non-finite (keeps the
  // previous), per spec.
  get globalAlpha()  { return this._globalAlpha; }
  set globalAlpha(v) { v = +v; if (isFinite(v) && v >= 0 && v <= 1) this._globalAlpha = v; }

  // globalCompositeOperation: the setter ignores an unknown value (keeps the
  // previous), per spec.
  get globalCompositeOperation() { return this._gco; }
  set globalCompositeOperation(v) { if (KNOWN_GCO.has(v)) this._gco = v; }

  createLinearGradient(x0, y0, x1, y1) {
    // WebIDL doubles: a non-finite coordinate is a TypeError, before any other check.
    if (!allFinite(x0 = +x0, y0 = +y0, x1 = +x1, y1 = +y1)) throw new globalThis.TypeError('non-finite gradient coordinate');
    return new CanvasGradient('linear', {x0, y0, x1, y1});
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (!allFinite(x0 = +x0, y0 = +y0, r0 = +r0, x1 = +x1, y1 = +y1, r1 = +r1)) throw new globalThis.TypeError('non-finite gradient value');
    if (r0 < 0 || r1 < 0) throw new globalThis.DOMException('negative radius', 'IndexSizeError');
    return new CanvasGradient('radial', {x0, y0, r0, x1, y1, r1});
  }
  createConicGradient(startAngle, x, y) {
    if (!allFinite(startAngle = +startAngle, x = +x, y = +y)) throw new globalThis.TypeError('non-finite conic gradient value');
    return new CanvasGradient('conic', {a0: startAngle, x, y});
  }

  // createPattern(image, repetition): a tiled-image fill/stroke style. Only `null`
  // repetition (via [LegacyNullToEmptyString]) or '' defaults to 'repeat'; any other
  // non-keyword (including `undefined` → "undefined") is a SyntaxError. Image
  // usability (HTML "check the usability of the image argument") decides the rest:
  // a still-loading / srcless / zero-size <img> yields `null`; a BROKEN <img> (a
  // request that failed) or a zero-area canvas throws InvalidStateError.
  createPattern(image, repetition) {
    argc(arguments.length, 2);
    if (image == null) throw new globalThis.TypeError('createPattern: image is null');
    repetition = (repetition === null || repetition === '') ? 'repeat' : String(repetition);
    if (!PATTERN_REPS.has(repetition)) throw new globalThis.DOMException('bad repetition', 'SyntaxError');
    // A pattern built from a cross-origin (non-CORS-approved) source is itself tainted — painting
    // with it later taints whatever canvas it fills (pattern-from-{img,image,canvas}-cross-origin).
    const tainted = imageSourceTainted(image);
    const src = resolveImagePixels(image);
    if (src) {
      // A wide-profile source used in a P3 context tiles from its preserved P3 rendering.
      const useP3 = this._attrs.colorSpace === 'display-p3' && image._pixelsP3 && src.pixels === image._pixels;
      const px = useP3 ? image._pixelsP3 : src.pixels;
      const cs = useP3 ? 'display-p3' : sourceColorSpace(image);
      // Snapshot the source pixels — a later draw to a live source canvas must not
      // change the pattern.
      const p = new CanvasPattern(new globalThis.Uint8ClampedArray(px), src.width, src.height, repetition, cs);
      p._tainted = tainted;
      return p;
    }
    if (isCanvasSource(image)) {
      const w = image.width | 0, h = image.height | 0;
      if (!w || !h) throw new globalThis.DOMException('the canvas has zero size', 'InvalidStateError');
      const px = image._pixels || new globalThis.Uint8ClampedArray(w * h * 4);   // blank canvas → transparent tile
      const p = new CanvasPattern(new globalThis.Uint8ClampedArray(px), w, h, repetition, sourceColorSpace(image));
      p._tainted = tainted;
      return p;
    }
    // An <img>, SVG <image>, or <video> with no usable bitmap: per "check the usability
    // of the image argument", only a request that FAILED is "broken" (throw
    // InvalidStateError). A srcless / still-loading / zero-intrinsic-size image, or a
    // <video> with no decoded frame (readyState HAVE_NOTHING / HAVE_METADATA), is merely
    // "bad" usability → null. (<img> and SVG <image> share `_imgBroken` via
    // `_loadImageResource`.)
    if (image._tag === 'img' || image._tag === 'image' || image._tag === 'video') {
      if (image._imgBroken) throw new globalThis.DOMException('the image is broken', 'InvalidStateError');
      return null;
    }
    // Anything else is not a CanvasImageSource (e.g. a string / plain object) — a
    // WebIDL type error, not a usability error.
    throw new globalThis.TypeError('createPattern: the image is not a usable image source');
  }

  // Drawing-state stack. save() snapshots the transform + the state fields the
  // vector surface reads; restore() pops the most recent (a no-op when empty).
  // The current path is NOT part of the drawing state — it persists across
  // save/restore, per spec.
  save() {
    const s = {
      m: this._m.slice(), fill: this._fill, stroke: this._stroke, shadow: this._shadow,
      fillObj: this._fillObj, strokeObj: this._strokeObj, clip: this._clip, lineDash: this._lineDash,
    };
    for (const k of STATE_KEYS) s[k] = this[k];
    this._stack.push(s);
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._m = s.m; this._fill = s.fill; this._stroke = s.stroke; this._shadow = s.shadow;
    this._fillObj = s.fillObj; this._strokeObj = s.strokeObj; this._clip = s.clip; this._lineDash = s.lineDash;
    for (const k of STATE_KEYS) this[k] = s[k];
  }
  // setLineDash(sequence): each element is coerced to a number; if any is negative
  // or non-finite the whole call is ignored (the dash list is unchanged). An
  // odd-length list is duplicated so the on/off pattern is well defined.
  setLineDash(segments) {
    if (segments == null || typeof segments.length !== 'number') return;
    const list = [];
    for (let i = 0; i < segments.length; i++) {
      const v = +segments[i];
      if (!isFinite(v) || v < 0) return;
      list.push(v);
    }
    this._lineDash = list.length % 2 ? list.concat(list) : list;
  }
  getLineDash() { return this._lineDash.slice(); }

  // Transform stack. Each mutates the current transform matrix (CTM); rect fills
  // map their corners through it, so translate / scale / rotate all take effect.
  // Per spec every transform method is a no-op when any argument is non-finite
  // (NaN / ±Infinity) — the prior matrix is preserved rather than poisoned.
  translate(x, y) { argc(arguments.length, 2); if (allFinite(x = +x, y = +y)) this._m = mulMatrix(this._m, [1, 0, 0, 1, x, y]); }
  scale(x, y)     { argc(arguments.length, 2); if (allFinite(x = +x, y = +y)) this._m = mulMatrix(this._m, [x, 0, 0, y, 0, 0]); }
  rotate(rad) {
    argc(arguments.length, 1);
    if (!allFinite(rad = +rad)) return;
    const c = Math.cos(rad), s = Math.sin(rad);
    this._m = mulMatrix(this._m, [c, s, -s, c, 0, 0]);
  }
  transform(a, b, c, d, e, f) {
    argc(arguments.length, 6);
    if (allFinite(a = +a, b = +b, c = +c, d = +d, e = +e, f = +f)) this._m = mulMatrix(this._m, [a, b, c, d, e, f]);
  }
  // setTransform(a, b, c, d, e, f) or setTransform(DOMMatrix2DInit) — replace the CTM.
  // The two overloads take 0/1 args (the matrix, default identity) or exactly 6
  // (the components); 2–5 args, or a single non-object, matches neither → TypeError.
  setTransform(a, b, c, d, e, f) {
    const n = arguments.length;
    if (n === 0) { this._m = [1, 0, 0, 1, 0, 0]; return; }
    if (n === 1) {                                   // the DOMMatrix2DInit overload
      if (a == null) { this._m = [1, 0, 0, 1, 0, 0]; return; }   // null/undefined → default (identity)
      if (typeof a === 'object') { const m = matrix2DInit(a); if (m.every(isFinite)) this._m = m; return; }
      throw new globalThis.TypeError('setTransform: argument is not a DOMMatrix2DInit');
    }
    argc(n, 6);                                      // 2–5 args match neither overload
    if (allFinite(a = +a, b = +b, c = +c, d = +d, e = +e, f = +f)) this._m = [a, b, c, d, e, f];
  }
  // getTransform() — the current CTM as a fresh (2D) DOMMatrix.
  getTransform() {
    const m = this._m;
    return new globalThis.DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
  }
  resetTransform() { this._m = [1, 0, 0, 1, 0, 0]; }

  // ── Path building ───────────────────────────────────────────────────────
  // The current default path lives in a CanvasPath (shared with Path2D); the
  // building methods delegate to it. beginPath() replaces it with a fresh one.
  beginPath() { this._pathObj.reset(); }
  moveTo(x, y) { argc(arguments.length, 2); this._pathObj.moveTo(x, y); }
  lineTo(x, y) { argc(arguments.length, 2); this._pathObj.lineTo(x, y); }
  closePath() { this._pathObj.closePath(); }
  rect(x, y, w, h) { argc(arguments.length, 4); this._pathObj.rect(x, y, w, h); }
  roundRect(x, y, w, h, radii) { argc(arguments.length, 4); this._pathObj.roundRect(x, y, w, h, radii); }
  bezierCurveTo(a, b, c, d, e, f) { argc(arguments.length, 6); this._pathObj.bezierCurveTo(a, b, c, d, e, f); }
  quadraticCurveTo(a, b, c, d) { argc(arguments.length, 4); this._pathObj.quadraticCurveTo(a, b, c, d); }
  arc(a, b, c, d, e, f) { argc(arguments.length, 5); this._pathObj.arc(a, b, c, d, e, f); }
  ellipse(a, b, c, d, e, f, g, h) { argc(arguments.length, 7); this._pathObj.ellipse(a, b, c, d, e, f, g, h); }
  arcTo(a, b, c, d, e) { argc(arguments.length, 5); this._pathObj.arcTo(a, b, c, d, e); }

  // The CTM's scale, the larger of its two axes': the resolution text is rendered at, so it stays sharp in device
  // pixels under a transform.
  _ctmScale() {
    const m = this._m;
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) || 1;
  }

  // ── Paths, as the rasterizer takes them ──
  // The shape a path (the current default path, or a Path2D) fills under the CTM, by the even-odd rule or nonzero
  // (`__dom.canvasPathShape`).
  _fillShape(pathObj, evenOdd) {
    return globalThis.__dom.canvasPathShape([1, +evenOdd], pathObj._buf, this._m, pathObj._baked);
  }
  // …and the one its stroke covers with a `width` pen (canvas_path.rs `Pen`): its caps and joins, and the dash pattern
  // (none for a focus ring).
  _strokeShape(pathObj, width, cap = this._lineCap, join = this._lineJoin, miterLimit = this._miterLimit, dash = this._lineDash) {
    return globalThis.__dom.canvasPathShape([3, width, CAPS.indexOf(cap), JOINS.indexOf(join), miterLimit, this._lineDashOffset || 0, dash.length, ...dash],
                                            pathObj._buf, this._m, pathObj._baked);
  }
  // A user-space rectangle as a path, through the CTM — one scratch path, reset each time: the shape built from it is
  // a copy, made before it is next needed.
  _rectPath(x, y, w, h) {
    const p = this._rectScratch;
    p.reset();
    p.rect(x, y, w, h);
    return p;
  }

  // Lazily allocate (and return) the backing pixel buffer, or null for a
  // zero-area canvas. Sized to the canvas's current width × height.
  _buffer() {
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return null;
    if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    return this.canvas._pixels;
  }

  // True when the CTM is axis-aligned (no rotation / shear), so a rect maps to a
  // rect and the box coverage fast path applies.
  _axisAligned() { return this._m[1] === 0 && this._m[2] === 0; }

  // ── Drawing: one operation, handed to the rasterizer ──
  // Draw `shape` (`_fillShape`, `_strokeShape`, `_rectShape`, or a glyph mask's) with `paint` (`_paintOf`, an image's,
  // clearRect's; null paints nothing) into the bitmap (`__dom.canvasDraw`): under the clip, the operator, `globalAlpha` and the shadow — or,
  // `plain`, opaque and source-over with none, as a focus ring is drawn.
  _draw(shape, paint, plain = false) {
    const buf = this._buffer();
    if (!buf || !paint) return;
    const m = this._m, sh = this._shadow;
    const state = new globalThis.Float64Array([
      this.canvas.width | 0, this.canvas.height | 0, plain ? 1 : this.globalAlpha, m[0], m[1], m[2], m[3], m[4], m[5],
      +(this._attrs.colorSpace === 'display-p3'), sh.r, sh.g, sh.b, plain ? 0 : sh.a,
      this.shadowBlur, this.shadowOffsetX, this.shadowOffsetY,
    ]);
    globalThis.__dom.canvasDraw(buf, this._clip, shape, paint.mask || null, paint.data, paint.pixels || null, state,
                                plain ? 'source-over' : this._gco);
  }
  // The paint of a fill / stroke style — a gradient, a pattern, or the solid colour — as `_draw` takes it. Painting
  // with a tainted pattern (createPattern of a cross-origin source) taints this canvas.
  _paintOf(obj, solid) {
    if (obj instanceof CanvasPattern) {
      if (obj._tainted) this._originClean = false;
      return { data: obj._paint(), pixels: obj._px };
    }
    if (obj instanceof CanvasGradient) return { data: obj._paint() };
    return { data: new globalThis.Float64Array([0, solid.r, solid.g, solid.b, solid.a]) };
  }
  // A user-space rectangle's shape: its device box where the CTM keeps it axis-aligned, its corners' ring otherwise.
  _rectShape(x, y, w, h) {
    const m = this._m;
    if (this._axisAligned()) {
      return new globalThis.Float64Array([0, m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5]]);
    }
    return this._fillShape(this._rectPath(x, y, w, h), false);
  }

  // fill([path,] [fillRule]): rasterize the given path (or the current default
  // path), subpaths implicitly closed, under the winding rule ('nonzero' default,
  // or 'evenodd').
  fill(a, b) {
    const path = a instanceof CanvasPath ? a : this._pathObj;
    const ruleArg = a instanceof CanvasPath ? b : a;
    if (!path._empty) this._draw(this._fillShape(path, ruleArg === 'evenodd'), this._paintOf(this._fillObj, this._fill));
  }

  // stroke([path]): the path thickened by the pen (lineWidth, lineCap / lineJoin, the dash pattern) and painted in one
  // nonzero pass — the union covers overlaps exactly once, so a translucent strokeStyle doesn't darken at corners.
  stroke(path) {
    const p = path instanceof CanvasPath ? path : this._pathObj;
    if (!p._empty) this._draw(this._strokeShape(p, this.lineWidth), this._paintOf(this._strokeObj, this._stroke));
  }

  // clip([path,] [fillRule]): intersect the clip region with the given path (or the current default path), so
  // subsequent draws are masked (`__dom.canvasClip` fills the mask: a pixel is inside where it is at least half
  // covered). Part of the
  // drawing state (save/restore'd); clip() only ever shrinks the region.
  clip(a, b) {
    const path = a instanceof CanvasPath ? a : this._pathObj;
    const ruleArg = a instanceof CanvasPath ? b : a;
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    const mask = new globalThis.Uint8Array(cw * ch);   // (…a canvas too large for one is a RangeError here)
    globalThis.__dom.canvasClip(mask, cw, ch, this._fillShape(path, ruleArg === 'evenodd'), this._clip);
    this._clip = mask;
  }

  // isPointInPath([path,] x, y [, fillRule]) — is the point, in canvas coordinate space (unaffected by the current
  // transform), inside the given path (or the current default path) under the winding rule, as fill() would paint it
  // (`__dom.canvasHit`)? A point exactly on the boundary is inside; under a non-invertible CTM nothing is.
  isPointInPath(a, b, c, d) {
    argc(arguments.length, 2);
    let path, x, y, rule;
    // Overload by the first argument: a Path2D selects the (path, x, y, fillRule)
    // form; anything else is the (x, y, fillRule) form with x coerced by ToNumber.
    // Invalid inputs surface as a TypeError via the fill-rule check — e.g.
    // isPointInPath(null, 50, 50) coerces to x=0, y=50, fillRule=50 (not an enum).
    if (a instanceof CanvasPath) { path = a; x = +b; y = +c; rule = d; }
    else                         { path = this._pathObj; x = +a; y = +b; rule = c; }
    if (rule !== undefined && rule !== 'nonzero' && rule !== 'evenodd') {
      throw new globalThis.TypeError('isPointInPath: invalid fill rule');
    }
    return globalThis.__dom.canvasHit(this._fillShape(path, rule === 'evenodd'), x, y);
  }

  // isPointInStroke([path,] x, y) — is the point (in canvas coordinate space) on the stroke? Tested against the stroke
  // stroke() would paint, so caps, joins, a non-uniform pen and the dash pattern are all honoured exactly (a point just
  // past a butt-capped dash end is outside).
  isPointInStroke(a, b, c) {
    argc(arguments.length, 2);
    let path = this._pathObj, x, y;
    if (a instanceof CanvasPath) { path = a; x = +b; y = +c; } else { x = +a; y = +b; }
    return globalThis.__dom.canvasHit(this._strokeShape(path, this.lineWidth), x, y);
  }

  // Reset the bitmap to transparent black and the context to its default state.
  reset() { this.canvas._pixels = null; this._resetState(); }
  getContextAttributes() { return {...this._attrs}; }
  isContextLost() { return false; }
  // drawFocusIfNeeded([path,] element): if `element` is focused and is fallback
  // content of this canvas, draw a focus ring along the path — so keyboard / AT users
  // can see which control the path represents. A real UA paints a platform-styled ring;
  // we stroke a 2px opaque outline of the path, which satisfies the observable contract
  // (the canvas changes only when the associated element is actually focused).
  drawFocusIfNeeded(a, b) {
    argc(arguments.length, 1);
    const path    = a instanceof CanvasPath ? a : this._pathObj;
    const element = a instanceof CanvasPath ? b : a;
    if (!element || element._nodeType !== 1) {
      throw new globalThis.TypeError('drawFocusIfNeeded: the element argument is not an Element');
    }
    // Nothing to draw unless the element is the document's focused element AND is
    // fallback content of this canvas (an OffscreenCanvas has no document → never).
    const doc = this.canvas.ownerDocument;
    if (!doc || doc.activeElement !== element) return;
    if (typeof this.canvas._contains !== 'function' || !this.canvas._contains(element)) return;
    // A focus ring is a UA decoration, not an author stroke: build a plain solid
    // outline, ignoring the author's dash pattern and cap/join, and (below) paint it
    // opaque + source-over, ignoring globalAlpha / globalCompositeOperation / shadow —
    // which would otherwise dash it, fade it, shadow it, or (under a whole-canvas
    // operator like 'copy') erase the rest of the canvas. The clip still applies.
    if (!path._empty) this._draw(this._strokeShape(path, 2, 'butt', 'miter', 10, []), this._paintOf(null, {r: 0, g: 0, b: 0, a: 1}), true);
  }

  // ── Text ──
  // An element's font-size and used line-height (px), for the font-relative units of `font` — null where the canvas
  // has no element to ask (an OffscreenCanvas). An element not in a document has no font-size of its own: `defaultFs`
  // (the canvas's 10px, the root's 16px) stands for it, as it does for a `normal` line height's 1.2.
  _fontBase(el, defaultFs) {
    if (!el || el._nodeType !== 1 || !globalThis.getComputedStyle) return null;
    let fs = defaultFs, lh = NaN;
    try {
      const cs = globalThis.getComputedStyle(el);
      if (el.isConnected) fs = parseFloat(cs.fontSize) || defaultFs;
      lh = parseFloat(cs.lineHeight);   // (…px, or `normal`)
    } catch (_) { /* fall through */ }
    return {fs, lh: lh > 0 ? lh : fs * 1.2};
  }
  // …the root's, for `rem` / `rlh`.
  _rootBase() {
    const doc = this.canvas && this.canvas.ownerDocument;
    return this._fontBase(doc && doc.documentElement, 16);
  }

  // A CSS `font` shorthand computed (spec: at assignment time), or null if it does not parse — the style engine's,
  // `__dom.canvasFont`: `[serialization, px, weight, slant, smallCaps, firstFamily]`, its size in px, `em` / `%` of the
  // canvas element's font size, `rem` of the root's, `lh` / `rlh` of their line heights. A lone system-font keyword is
  // the platform UI font, which is not modelled: one concrete default stands for all.
  _computeFont(input) {
    const raw = String(input).trim();
    if (FONT_SYSTEM_KW.has(raw.toLowerCase())) return globalThis.__dom.canvasFont('16px sans-serif', NaN, NaN, NaN, NaN);
    // (…the bases asked for only where a relative unit can want them: each is a style read)
    if (!/em|%|lh/i.test(raw)) return globalThis.__dom.canvasFont(raw, NaN, NaN, NaN, NaN);
    const own = this._fontBase(this.canvas, 10), root = this._rootBase();
    return globalThis.__dom.canvasFont(raw, own ? own.fs : 10, root ? root.fs : 16, own ? own.lh : NaN, root ? root.lh : NaN);
  }

  // The face the current font's family stack resolves to — as a page's text does (font-metrics.js: its `@font-face`
  // where the document declares one, else the system face fontconfig gives it) — at a weight of 600 or more bold, an
  // italic or oblique style italic: its native handle (font.rs), which canvasText shapes and draws with.
  _face() {
    const [, , weight, slant, , family] = this._fontParts;
    const bucket = (weight >= 600 ? 'bold' : '') + (slant ? (weight >= 600 ? ':italic' : 'italic') : '');
    return fontHandleFor(family, bucket);
  }
  // Whether the line is set in small capitals: the font's `small-caps`, or any `fontVariantCaps` but normal.
  _smallCaps() {
    return this._fontParts[4] || this._fontVariantCaps !== 'normal';
  }

  // A letter / word spacing in px (`__dom.canvasSpacing`): re-resolved on every measure, so a font-relative one follows
  // the CURRENT font's size, a `rem` the root's.
  _spacingPx(v) {
    const root = /rem/i.test(v) ? this._rootBase() : null;
    const p = globalThis.__dom.canvasSpacing(v, this._fontParts[1], root ? root.fs : 16);
    return p ? p[1] : 0;
  }

  // Total advance added by letter/word spacing for `text`: letter spacing after each
  // character, word spacing at each ASCII space.
  _spacingWidth(text) {
    if (this._letterSpacing === '0px' && this._wordSpacing === '0px') return 0;   // default fast path
    const ls = this._spacingPx(this._letterSpacing), ws = this._spacingPx(this._wordSpacing);
    if (!ls && !ws) return 0;
    let chars = 0, spaces = 0;
    for (const ch of text) { chars++; if (ch === ' ') spaces++; }
    return ls * chars + ws * spaces;
  }

  measureText(text) {
    argc(arguments.length, 1);
    text = String(text).replace(CANVAS_TEXT_WS, ' ');
    const face = this._face(), px = this._fontParts[1], kern = this._fontKerning !== 'none', caps = this._smallCaps();
    const rtl = this._effectiveDirection() === 'rtl';
    const key = face + '\0' + px + '\0' + kern + '\0' + caps + '\0' + rtl + '\0' + text;   // user-space units (transform-independent)
    let m = measureCache.get(key);
    if (!m) {
      // (…a face native reads none of is measured as an unknown font is: a 6px advance a character, 8 and 2 high)
      const r = globalThis.__dom.canvasText(text, face, px, kern, caps, rtl);
      const asc = r ? r.ascent : 8, desc = r ? r.descent : 2;
      m = {
        width:                    r ? r.advance : text.length * 6,
        // Ink-box edges relative to the text origin: left is positive going left
        // (a positive left side-bearing → negative left), right is the ink's far edge.
        actualBoundingBoxLeft:    r ? -r.inkLeft : 0,
        actualBoundingBoxRight:   r ? r.inkRight : text.length * 6,
        actualBoundingBoxAscent:  r ? r.inkAscent : asc,
        actualBoundingBoxDescent: r ? r.inkDescent : desc,
        fontBoundingBoxAscent:    asc,
        fontBoundingBoxDescent:   desc,
        emHeightAscent:           r ? r.emAscent : px * 0.8,
        emHeightDescent:          r ? r.emDescent : px * 0.2,
        // The face's BASE table gives exact baselines when it has one; otherwise they come
        // off the vertical metrics, as Chrome derives them (measured).
        hangingBaseline:          r && r.hangingBaseline     != null ? r.hangingBaseline     : asc * 0.8,
        alphabeticBaseline:       0,
        ideographicBaseline:      r && r.ideographicBaseline != null ? r.ideographicBaseline : -desc,
      };
      if (measureCache.size > 4000) measureCache.clear();
      measureCache.set(key, m);
    }
    // Letter/word spacing widen the advance, and the actualBoundingBox* metrics are
    // measured from the text ORIGIN — which is the alignment anchor, so right/end-aligned
    // (or rtl start) text has the origin at its right edge (box extends left → Left>Right)
    // and center splits it. Both depend on state outside the font+text cache key, so apply
    // them to a copy of the cached (left-aligned, unspaced) base metrics.
    const extra = this._spacingWidth(text);
    const width = m.width + extra;
    const align = this._resolveTextAlign();
    const shift = align === 'right' ? width : align === 'center' ? width / 2 : 0;
    if (!extra && !shift) return m;
    return {
      ...m,
      width,
      actualBoundingBoxLeft:  m.actualBoundingBoxLeft + shift,
      actualBoundingBoxRight: m.actualBoundingBoxRight - shift,
    };
  }

  fillText(text, x, y, maxWidth) { argc(arguments.length, 3); this._drawText(text, x, y, maxWidth, this._fillObj, this._fill); }
  // strokeText is approximated as a filled glyph (glyph-outline stroking isn't
  // modeled) — the common use is a visible label; the fill/stroke colour differs.
  strokeText(text, x, y, maxWidth) { argc(arguments.length, 3); this._drawText(text, x, y, maxWidth, this._strokeObj, this._stroke); }

  // `letterSpacing` / `wordSpacing` widen what a line measures and must open the gaps they measure:
  // a whole line is one mask, which has no room for a gap between two glyphs, so a spaced run is
  // drawn one character at a time, each at the pen position the previous one's advance plus the
  // spacing leaves — which is what the spec's "add letter-spacing after each character" means in
  // pixels. Alignment and `maxWidth` are measured on the whole SPACED advance, as they are for an
  // unspaced run, and the condensing factor squashes glyph and gap alike. Returns false to let the
  // ordinary path draw when there is nothing to space (no spacing after resolution, or a single
  // character).
  _drawSpaced(text, x, y, maxWidth, obj, solid) {
    const ls = this._spacingPx(this._letterSpacing), ws = this._spacingPx(this._wordSpacing);
    if (!ls && !ws) return false;
    const chars = Array.from(text);
    if (chars.length < 2 && !ls) return false;
    // Advances are measured UNSPACED — the loop adds the spacing itself — so the two spacings are
    // switched off for the duration and put back whatever happens.
    const savedLs = this._letterSpacing, savedWs = this._wordSpacing, savedAlign = this.textAlign;
    this._letterSpacing = '0px'; this._wordSpacing = '0px';
    try {
      // Each character's advance as the difference between the line's first i + 1 characters and
      // its first i, as shaped — so a kerned pair keeps its kerning between the gaps.
      const measure = (t) => this.measureText(t).width;
      const advance = (i) => measure(chars.slice(0, i + 1).join('')) - measure(chars.slice(0, i).join(''));
      const steps = chars.map((ch, i) => advance(i) + ls + (ch === ' ' || ch === '\u00A0' ? ws : 0));
      const total = steps.reduce((a, b) => a + b, 0);
      const factor = maxWidth !== undefined && total > +maxWidth ? +maxWidth / total : 1;
      // Alignment on the whole run: the characters are then laid down left-to-right from the
      // aligned start, each with its own left-aligned anchor.
      const align = this._resolveTextAlign();
      let pen = x - (align === 'center' ? total * factor / 2 : align === 'right' ? total * factor : 0);
      this.textAlign = 'left';
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch !== ' ' && ch !== '\u00A0') {
          const own = this.measureText(ch).width * factor;
          this._drawText(ch, pen, y, own > 0 ? own : undefined, obj, solid);
        }
        pen += steps[i] * factor;
      }
    } finally {
      this._letterSpacing = savedLs; this._wordSpacing = savedWs; this.textAlign = savedAlign;
    }
    return true;
  }

  // Shape `text` and draw it (`__dom.canvasText`, at the device font size under the CTM's scale, placed by textAlign /
  // textBaseline / maxWidth at the anchor the CTM puts x, y at), with the fill / stroke paint like any other shape.
  // Rotation / shear of the CTM positions the anchor but doesn't rotate the glyphs.
  _drawText(text, x, y, maxWidth, obj, solid) {
    text = String(text).replace(CANVAS_TEXT_WS, ' ');
    if (!text || !allFinite(x = +x, y = +y)) return;
    // A PROVIDED maxWidth that is ≤ 0 or NaN means "draw nothing" (spec), not "no
    // limit" — distinct from an omitted maxWidth (undefined), which is unconstrained.
    if (maxWidth !== undefined && !(+maxWidth > 0)) return;
    if (this._letterSpacing !== '0px' || this._wordSpacing !== '0px') {
      if (this._drawSpaced(text, x, y, maxWidth, obj, solid)) return;
    }
    if (!this._buffer()) return;
    const scale = this._ctmScale() || 1;
    const m = this._m, align = this._resolveTextAlign();
    // The pixels that can reach the canvas: its own, and those the shadow's offset brings onto it — and its blur, by
    // a reach canvasText works out.
    const w = this.canvas.width | 0, h = this.canvas.height | 0, shadow = this._shadow.a > 0;
    const ox = shadow ? +this.shadowOffsetX : 0, oy = shadow ? +this.shadowOffsetY : 0;
    const place = new globalThis.Float64Array([
      m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5],
      align === 'center' ? 0.5 : align === 'right' ? 1 : 0,
      TEXT_BASELINES.indexOf(this.textBaseline),
      maxWidth !== undefined ? +maxWidth * scale : 0,                    // device px: the line is drawn at the CTM's scale
      Math.min(0, -ox), Math.min(0, -oy), Math.max(w, w - ox), Math.max(h, h - oy),
      shadow ? this.shadowBlur : 0,
    ]);
    const r = globalThis.__dom.canvasText(text, this._face(), this._fontParts[1] * scale, this._fontKerning !== 'none', this._smallCaps(),
                                          this._effectiveDirection() === 'rtl', place);
    if (!r) return;
    const paint = this._paintOf(obj, solid);
    // (…a line with no ink on the canvas still composites: a transparent source clears what a whole-canvas operator —
    // copy, source-in, … — clears outside a shape)
    paint.mask = r.mask || new globalThis.Uint8Array(1);
    this._draw(new globalThis.Float64Array(r.mask ? [2, r.maskWidth, r.maskHeight, r.maskX, r.maskY] : [2, 1, 1, 0, 0]), paint);
  }

  // The effective text direction: `ctx.direction` when explicit ('ltr'/'rtl'), otherwise
  // ('inherit') the canvas element's computed direction (its `dir` attribute / CSS).
  // The inherited case memoizes the getComputedStyle read per tree generation so a
  // steady draw loop of default start-aligned text doesn't re-run the cascade each call.
  _effectiveDirection() {
    const d = this._direction;
    if (d === 'ltr' || d === 'rtl') return d;
    // getComputedStyle(canvas).direction is cascade-derived, so key the memo on BOTH the
    // tree generation AND the cascade version — a deferred stylesheet / @media change
    // rebuilds the cascade without a DOM mutation, so the tree generation alone would go stale.
    const gen = globalThis.__csimTreeGen ? globalThis.__csimTreeGen() : 0;
    const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
    if (this._inheritDirGen === gen && this._inheritDirCV === cv) return this._inheritDir;
    let dir = 'ltr';
    try {
      const el = this.canvas;
      if (el && el._nodeType === 1 && globalThis.getComputedStyle) {
        dir = globalThis.getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
      }
    } catch (_) { /* offscreen / detached → ltr */ }
    this._inheritDirGen = gen; this._inheritDirCV = cv; this._inheritDir = dir;
    return dir;
  }

  // textAlign resolves start/end against the effective direction: rtl swaps them (start is
  // the right edge, end the left). left/right/center pass through unaffected.
  _resolveTextAlign() {
    const a = this.textAlign;
    if (a !== 'start' && a !== 'end') return a;
    const rtl = this._effectiveDirection() === 'rtl';
    return a === 'start' ? (rtl ? 'right' : 'left') : (rtl ? 'left' : 'right');
  }

  fillRect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    this._draw(this._rectShape(x, y, w, h), this._paintOf(this._fillObj, this._fill));
  }

  // clearRect ignores fillStyle / globalAlpha and casts NO shadow — it clears the covered pixels (a partly covered
  // edge in proportion), inside the clip.
  clearRect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    this._draw(this._rectShape(x, y, w, h), { data: new globalThis.Float64Array([1]) });
  }

  // strokeRect strokes the rectangle's closed path, exactly as stroke() would: its four corners honor lineJoin /
  // miterLimit, a degenerate (zero-w/-h) rect strokes as the line it is, and the stroke scales / rotates with the CTM.
  strokeRect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || (!w && !h)) return;
    this._draw(this._strokeShape(this._rectPath(x, y, w, h), this.lineWidth), this._paintOf(this._strokeObj, this._stroke));
  }

  drawImage(source, ...args) {
    argc(arguments.length, 3);   // drawImage(image, dx, dy) is the smallest overload
    // A non-object source (null / undefined / number / string) matches no
    // CanvasImageSource overload — a WebIDL TypeError.
    if (source === null || typeof source !== 'object') {
      throw new globalThis.TypeError('drawImage: the image argument is not a canvas image source');
    }
    let src = resolveImagePixels(source);
    if (!src && isCanvasSource(source)) {
      // A canvas source with a zero dimension is an InvalidStateError; a blank (undrawn)
      // but sized canvas is a fully-transparent image — it must still DRAW (as transparent
      // pixels), not no-op, so a whole-canvas operator (source-in / copy / …) clears the
      // destination it isn't covering.
      const w = source.width | 0, h = source.height | 0;
      if (!w || !h) throw new globalThis.DOMException('the source canvas has zero size', 'InvalidStateError');
      src = {pixels: new globalThis.Uint8ClampedArray(w * h * 4), width: w, height: h};
    }
    if (!src) {
      // An object that isn't a CanvasImageSource at all is a TypeError. A recognized
      // but unusable source (broken / not-yet-loaded / srcless image) draws nothing —
      // our synchronous decode can't tell a failed request from one still loading, so we
      // don't throw the spec's broken-image InvalidStateError (it would break drawing a
      // still-loading image, which must be a no-op).
      if (!isImageSourceType(source)) {
        throw new globalThis.TypeError('drawImage: the image argument is not a canvas image source');
      }
      return;
    }
    // A usable but cross-origin (non-CORS-approved) source taints this canvas — even a
    // geometrically-clipped or off-canvas draw, per spec (the source's pixels became reachable).
    if (imageSourceTainted(source)) this._originClean = false;
    // A wide-profile (Adobe/CMYK) source carries a separate Display-P3 rendering — use it (not the clipped sRGB one)
    // when drawing into a P3 canvas, so its wide colours survive. The rasterizer brings the source into this canvas's
    // colour space (on its own copy, which also keeps a canvas drawn onto itself reading its pixels from before).
    let srcCS = sourceColorSpace(source);
    if (this._attrs.colorSpace === 'display-p3' && source._pixelsP3 && src.pixels === source._pixels) {
      src = { pixels: source._pixelsP3, width: src.width, height: src.height };
      srcCS = 'display-p3';
    }
    const iw = src.width, ih = src.height;
    let sx = 0, sy = 0, sw = iw, sh = ih, dx, dy, dw, dh;
    if      (args.length === 2) { dx = +args[0]; dy = +args[1]; dw = iw; dh = ih; }
    else if (args.length === 4) { dx = +args[0]; dy = +args[1]; dw = +args[2]; dh = +args[3]; }
    else if (args.length === 8) { sx = +args[0]; sy = +args[1]; sw = +args[2]; sh = +args[3];
                                  dx = +args[4]; dy = +args[5]; dw = +args[6]; dh = +args[7]; }
    else return;
    if (!allFinite(sx, sy, sw, sh, dx, dy, dw, dh)) return;   // a non-finite argument is a no-op
    if (sw === 0 || sh === 0) return;                         // a zero-size source rect draws nothing
    // Drawn like any other shape — the destination rectangle through the CTM — under the clip, globalAlpha, the
    // operator and the shadow, each covered pixel sampling the source (nearest, or bilinear where smoothing is on and
    // the image is scaled or rotated; a negative dw / dh mirrors).
    this._draw(this._fillShape(this._rectPath(dx, dy, dw, dh), false), {
      data: new globalThis.Float64Array([6, iw, ih, +(srcCS === 'display-p3'), sx, sy, sw, sh, dx, dy, dw, dh, +!!this.imageSmoothingEnabled]),
      pixels: src.pixels,
    });
  }

  getImageData(x, y, w, h, settings) {
    x = enforceLong(x); y = enforceLong(y);   // non-finite coords → TypeError
    w = enforceLong(w); h = enforceLong(h);
    if (w === 0 || h === 0) throw new globalThis.DOMException('getImageData: width or height is zero', 'IndexSizeError');
    if (w < 0) { x += w; w = -w; }   // a negative extent normalizes the rect (spec)
    if (h < 0) { y += h; h = -h; }
    assertImageArea(w, h);           // throw (not crash) on an un-allocatable region
    // A tainted canvas can't be read back — reading a cross-origin image's pixels is the leak the
    // origin-clean flag exists to prevent (getImageData "if not origin-clean, throw SecurityError").
    if (!this._originClean) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    const cw  = this.canvas.width  | 0;
    const ch  = this.canvas.height | 0;
    const out = new globalThis.Uint8ClampedArray(w * h * 4);
    const src = this.canvas._pixels;
    if (src) blitRGBA(src, cw, ch, x, y, w, h, out, w, h, 0, 0, w, h);
    // The backing holds values in this context's colour space; convert to the
    // requested one on readback. An absent `settings.colorSpace` defaults to the
    // context's colour space (not sRGB). `out` is a fresh copy, so this doesn't
    // touch the backing store.
    const colorSpace = this._imageDataColorSpace(settings);
    convertColorSpace(out, this._attrs.colorSpace, colorSpace);
    return new ImageData(out, w, h, { colorSpace });
  }
  // The colour space for a getImageData / createImageData result: the explicit
  // setting when valid, else the context's own colour space.
  _imageDataColorSpace(settings) {
    const cs = settings && settings.colorSpace;
    return (cs === 'srgb' || cs === 'display-p3') ? cs : this._attrs.colorSpace;
  }

  putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
    if (!(imageData instanceof ImageData)) throw new globalThis.TypeError('putImageData: first argument is not an ImageData');
    dx = enforceLong(dx); dy = enforceLong(dy);   // non-finite coords → TypeError
    const cw = this.canvas.width  | 0;
    const ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    const iw = imageData.width, ih = imageData.height;
    let drX = dirtyX == null ? 0  : enforceLong(dirtyX);
    let drY = dirtyY == null ? 0  : enforceLong(dirtyY);
    let drW = dirtyW == null ? iw : enforceLong(dirtyW);
    let drH = dirtyH == null ? ih : enforceLong(dirtyH);
    if (drW < 0) { drX += drW; drW = -drW; }   // a negative dirty extent normalizes
    if (drH < 0) { drY += drH; drH = -drH; }
    // Convert the ImageData into this context's colour space before writing it to
    // the backing (on a copy, so the caller's buffer is untouched).
    let srcData = imageData.data;
    if (imageData.colorSpace !== this._attrs.colorSpace) {
      srcData = convertColorSpace(new globalThis.Uint8ClampedArray(srcData), imageData.colorSpace, this._attrs.colorSpace);
    }
    blitRGBA(srcData, iw, ih, drX, drY, drW, drH,
             this.canvas._pixels, cw, ch, dx + drX, dy + drY, drW, drH);
  }

  createImageData(arg1, arg2, settings) {
    if (!(this instanceof CanvasRenderingContext2D)) throw new globalThis.TypeError('createImageData called on a non-context');
    if (arg2 === undefined) {   // createImageData(imagedata) — copy its dimensions + colour space
      if (!(arg1 instanceof ImageData)) throw new globalThis.TypeError('createImageData: argument is not an ImageData');
      return new ImageData(arg1.width, arg1.height, { colorSpace: arg1.colorSpace });
    }
    const w = Math.abs(enforceLong(arg1));   // takes the absolute magnitude of the size
    const h = Math.abs(enforceLong(arg2));
    if (w === 0 || h === 0) throw new globalThis.DOMException('createImageData: width or height is zero', 'IndexSizeError');
    // An absent settings.colorSpace defaults to the context's colour space.
    return new ImageData(w, h, { colorSpace: this._imageDataColorSpace(settings) });
  }
}

export class OffscreenCanvas {
  constructor(width, height) {
    this._width  = width  | 0;
    this._height = height | 0;
    this._pixels = null;
    this._ctx    = null;
  }
  // Assigning width/height resets the bitmap to transparent black (sized to the
  // new dimensions) and the 2D context state — the same reset a DOM <canvas> does.
  get width()  { return this._width; }
  set width(v)  { this._width  = v | 0; this._reset(); }
  get height() { return this._height; }
  set height(v) { this._height = v | 0; this._reset(); }
  _reset() { this._pixels = null; if (this._ctx) this._ctx._resetState(); }
  getContext(type, options) {
    if (type !== '2d' && type !== 'bitmaprenderer') return null;
    this._ctx = this._ctx || new CanvasRenderingContext2D(this, options);
    return this._ctx;
  }
  transferToImageBitmap() {
    const bm = new ImageBitmap();
    bm._pixels = this._pixels && new globalThis.Uint8ClampedArray(this._pixels);
    bm.width   = this.width;
    bm.height  = this.height;
    bm._tainted = canvasTainted(this);   // the bitmap inherits the canvas's origin-clean flag
    // Per spec, transferTo… resets the source.
    this._pixels = null;
    return bm;
  }
  // `options` an ImageEncodeOptions (a dictionary: an object, or none; its members read in order — quality, then
  // type — and converted, before anything else); then a tainted bitmap and one with no pixels reject at once, in that
  // order. The bitmap is serialised at the call, and the promise settled in a task: with the Blob, or an EncodingError.
  convertToBlob(options) {
    try {
      if (options != null && typeof options !== 'object' && typeof options !== 'function') throw new globalThis.TypeError('convertToBlob: the options are not a dictionary');
      const quality = options?.quality, type = options?.type;
      const q = quality === undefined ? NaN : +quality;
      const t = type === undefined ? 'image/png' : `${type}`;
      if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
      if (!(this.width | 0) || !(this.height | 0)) throw new globalThis.DOMException('The canvas has no pixels.', 'IndexSizeError');
      const blob = canvasEncodeBlob(this, t, q);
      return new Promise((resolve, reject) => globalThis.setTimeout(() => {
        if (blob) resolve(blob);
        else reject(new globalThis.DOMException('The bitmap could not be encoded.', 'EncodingError'));
      }, 0));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

// The canvas's bitmap serialised as an image file (`__dom.encodeImage`) in its own colour space: `[mime, bytes]`, the
// type it was written as (an unsupported type is PNG) — or null for a canvas with no pixels, or a size the format
// cannot hold. A sized canvas never drawn on is transparent black: a browser always backs one. `type` is a string and
// `quality` a number already, NaN for none.
function encodeBitmap(canvas, type, quality) {
  const w = canvas.width | 0, h = canvas.height | 0;
  if (!w || !h) return null;
  const pixels = canvas._pixels || new globalThis.Uint8ClampedArray(w * h * 4);
  return globalThis.__dom.encodeImage(pixels, w, h, type, quality, sourceColorSpace(canvas)) || null;
}
// toBlob / toDataURL's `type` (a DOMString, `image/png` where it is missing) and `quality` (`any`: only a Number is one).
function encodeArgs(type, quality) {
  return [type === undefined ? 'image/png' : `${type}`, typeof quality === 'number' ? quality : NaN];
}
// …as a Blob, or null.
function canvasEncodeBlob(canvas, type, quality) {
  const file = encodeBitmap(canvas, type, quality);
  return file && new globalThis.Blob([file[1]], {type: file[0]});
}
// …as a `data:` URL; the empty one, `data:,`, where there is no file.
function canvasToDataURL(canvas, type, quality) {
  const file = encodeBitmap(canvas, type, quality);
  return file ? 'data:' + file[0] + ';base64,' + file[1].toBase64() : 'data:,';
}

export function installCanvasOutputs(ElementCtor) {
  const proto = ElementCtor.prototype;
  if (proto._csimCanvasOutputsInstalled) return;
  proto._csimCanvasOutputsInstalled = true;
  // toBlob (§4.12.5.1): its arguments converted first (a callback that is not one is a TypeError); a tainted canvas
  // throws; the bitmap is serialised NOW — the spec serialises a copy taken at the call, so a draw after it is not in
  // the file — and the callback invoked with the Blob, or null, in a task, an exception it throws reported.
  proto.toBlob = function (callback, type, quality) {
    if (typeof callback !== 'function') throw new globalThis.TypeError('toBlob: the callback is not a function');
    const args = encodeArgs(type, quality);
    if (this._tag !== 'canvas') return void globalThis.setTimeout(() => callback(null), 0);
    if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    const blob = canvasEncodeBlob(this, ...args);
    globalThis.setTimeout(() => callback(blob), 0);
  };
  proto.toDataURL = function (type, quality) {
    const args = encodeArgs(type, quality);
    if (this._tag !== 'canvas') return 'data:,';
    if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    return canvasToDataURL(this, ...args);
  };
}

globalThis.ImageData                = ImageData;
globalThis.ImageBitmap              = ImageBitmap;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.CanvasGradient           = CanvasGradient;
globalThis.CanvasPattern            = CanvasPattern;
globalThis.Path2D                   = Path2D;
globalThis.OffscreenCanvas          = OffscreenCanvas;
globalThis.createImageBitmap        = createImageBitmap;
