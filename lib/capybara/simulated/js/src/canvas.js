// The 2D canvas: an RGBA bitmap (`surfaceOf(canvas)._pixels`, a Uint8ClampedArray) and the CanvasRenderingContext2D,
// OffscreenCanvas, ImageData, ImageBitmap, CanvasGradient, CanvasPattern and Path2D surfaces over it. What a drawing
// operation does to the bitmap — its shape's coverage, its paint, the compositing operator, the clip, the shadow, the
// colour space — is native's (canvas.rs: `__dom.canvasDraw`), as are the paths it builds (canvas_path.rs) and the
// image file a bitmap is written as (image_encode.rs); this side keeps the drawing state, converts the arguments and
// hands each operation over. An image's bytes decode natively too (image_decode.rs), and a line of text is shaped and
// drawn to a coverage mask natively (text.rs).

import { latin1ToBytes }                                               from './bytes.js';
import { blobBytes, isBlob }                                           from './blob.js';
import { serializeAlpha } from './css-utils.js';
import { fontHandleFor }                                               from './font-metrics.js';
import { documentElementOf } from './document-tree.js';
import {
  PLATFORM, brandKey, bufferSourceByteLength, constructedBy, interfaceCheck, isBufferOf, makeSlots, registerInterface, slotsOf
} from './webidl.js';
import {
  convertImageDataArguments, convertPath2DArguments, defineCanvasGradient, defineCanvasPattern, defineImageBitmap,
  installCanvasRenderingContext2D,
  convertOffscreenCanvasArguments, installImageData, installOffscreenCanvas, installOffscreenCanvasRenderingContext2D,
  installPath2D, toCanvasRenderingContext2DSettings
} from './generated/bindings.js';
import { EventTarget, installEventHandlerAttrs } from './events.js';
import { UNSIGNED, reflectNumber, setReflectedNumber } from './reflect.js';

// An ImageData's pixel array wider than this many bytes can't be backed: "initialize an ImageData" rethrows the
// RangeError its allocation throws (whatwg/html#520), and the check comes BEFORE the attempt, which for an absurd size
// (a 2³¹-pixel getImageData) would OOM-abort the V8 isolate rather than throw a catchable error. `bytes` a component's.
const MAX_IMAGE_BYTES = 0xFFFFFFFF;   // ~4.29 GB
function assertImageArea(w, h, bytes = 1, prefix = '') {
  if (Math.abs(w) * Math.abs(h) * 4 * bytes > MAX_IMAGE_BYTES) {
    throw new RangeError(prefix + 'Out of memory at ImageData creation.');
  }
}

// ImageData (HTML §4.12.5.1.15), generated from its IDL: its width, height, colour space, pixel format and pixel array
// in its slots. Its two constructors are told apart by their first argument (an ImageDataArray, or a width):
//   new ImageData(sw, sh [, settings])               — transparent black pixels, made for it
//   new ImageData(data, sw [, sh [, settings]])      — the array given, its pixels
// A pixel array of the "rgba-unorm8" format is a Uint8ClampedArray, of "rgba-float16" a Float16Array.
const imageDataOf = (o) => slotsOf(o, 'ImageData');
registerInterface('ImageData', (o) => imageDataOf(o) !== undefined);
// (…each pixel format's array type: the realm's own Uint8ClampedArray, and its Float16Array looked up as it is used —
// the engine has none yet as the snapshot is built — and the type's name)
const Bytes = globalThis.Uint8ClampedArray;
const pixelArray = (format) => (format === 'rgba-float16' ? globalThis.Float16Array : Bytes);
const PIXEL_ARRAY_NAMES = { 'rgba-unorm8': 'Uint8ClampedArray', 'rgba-float16': 'Float16Array' };
export class ImageData {
  constructor(sw, sh) {
    const [form, ...args] = convertImageDataArguments(arguments);
    if (form === 'sw_sh_settings') {
      const [width, height, settings] = args;
      if (width === 0 || height === 0) throw new DOMException("Failed to construct 'ImageData': The source width or height is zero.", 'IndexSizeError');
      initializeImageData(this, width, height, settings);
    } else {
      const [data, width, height, settings] = args;
      // (…its byte length, a pixel 4 bytes in the "rgba-unorm8" format and 8 in "rgba-float16": an array of the
      // other format's type refused only as it is initialized, after these)
      const pixels = bufferSourceByteLength(data) / (settings.pixelFormat === 'rgba-unorm8' ? 4 : 8);
      if (pixels === 0 || !Number.isInteger(pixels)) {
        throw new DOMException("Failed to construct 'ImageData': The input data length is not a nonzero multiple of the bytes per pixel.", 'InvalidStateError');
      }
      if (width === 0 || pixels % width !== 0) {
        throw new DOMException("Failed to construct 'ImageData': The input data length is not a multiple of the width's pixels.", 'IndexSizeError');
      }
      if (height !== undefined && height !== pixels / width) {
        throw new DOMException("Failed to construct 'ImageData': The input data length is not the width's and the height's pixels.", 'IndexSizeError');
      }
      initializeImageData(this, width, pixels / width, settings, data);
    }
  }
}
// "Initialize an ImageData": its pixel array `source` — of its pixel format's type, an InvalidStateError otherwise — or
// a new one of transparent black (`assertImageArea`); its colour space the settings' or sRGB.
function initializeImageData(imageData, width, height, settings, source) {
  const type = pixelArray(settings.pixelFormat), name = PIXEL_ARRAY_NAMES[settings.pixelFormat];
  let data = source;
  if (data === undefined) {
    assertImageArea(width, height, type.BYTES_PER_ELEMENT, "Failed to construct 'ImageData': ");
    data = new type(width * height * 4);
  } else if (!isBufferOf(data, name)) {
    throw new DOMException(`Failed to construct 'ImageData': The input data is not a ${name} for the pixel format '${settings.pixelFormat}'.`, 'InvalidStateError');
  }
  makeSlots(imageData, 'ImageData', {
    width, height, data, colorSpace: settings.colorSpace ?? 'srgb', pixelFormat: settings.pixelFormat
  });
}
installImageData(ImageData, {
  get_width: (imageData) => imageDataOf(imageData).width,
  get_height: (imageData) => imageDataOf(imageData).height,
  get_data: (imageData) => imageDataOf(imageData).data,
  get_pixelFormat: (imageData) => imageDataOf(imageData).pixelFormat,
  get_colorSpace: (imageData) => imageDataOf(imageData).colorSpace
});
// An ImageData's pixels as RGBA bytes in a colour space a canvas holds — sRGB or Display P3, a linear one's converted to
// its encoded counterpart — and that space: its own array where they already are, a copy otherwise (a float16 one's
// components read as 8-bit values).
function imageDataPixels(s) {
  const colorSpace = s.colorSpace.replace(/-linear$/, '');
  const bytes = s.pixelFormat === 'rgba-float16' ? Bytes.from(s.data, (v) => v * 255) : s.data;
  if (colorSpace === s.colorSpace) return { bytes, colorSpace };
  return { bytes: convertColorSpace(bytes === s.data ? new Bytes(bytes) : bytes, s.colorSpace, colorSpace), colorSpace };
}
// …and a new ImageData of `bytes` (RGBA, a fresh Uint8ClampedArray in colour space `from`) as `settings` asks for
// (an ImageDataSettings, converted): in its colour space — `defaultColorSpace` where it names none — and its pixel
// format's array, a float16 one's components the bytes over 255.
function imageDataFromPixels(bytes, width, height, from, settings, defaultColorSpace) {
  const colorSpace = settings.colorSpace ?? defaultColorSpace;
  convertColorSpace(bytes, from, colorSpace);
  const data = settings.pixelFormat === 'rgba-float16' ? pixelArray('rgba-float16').from(bytes, (v) => v / 255) : bytes;
  const imageData = Object.create(ImageData.prototype);
  initializeImageData(imageData, width, height, { colorSpace, pixelFormat: settings.pixelFormat }, data);
  return imageData;
}
// An RGBA buffer converted IN PLACE from one colour space to another — sRGB and Display P3 natively
// (`__dom.canvasConvert`: a wide colour clipped into sRGB as a browser reads one back), each one's linear counterpart
// through its own transfer function (the sRGB curve, which Display P3 shares), its alpha untouched — a no-op where they
// match. Returns the buffer.
function convertColorSpace(data, from, to) {
  if (from === to) return data;
  const fromBase = from.replace(/-linear$/, ''), toBase = to.replace(/-linear$/, '');
  if (from !== fromBase) transferPixels(data, encodeComponent);
  if (fromBase !== toBase) globalThis.__dom.canvasConvert(data, fromBase === 'display-p3', toBase === 'display-p3');
  if (to !== toBase) transferPixels(data, decodeComponent);
  return data;
}
function transferPixels(data, f) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = f(data[i] / 255) * 255; data[i + 1] = f(data[i + 1] / 255) * 255; data[i + 2] = f(data[i + 2] / 255) * 255;
  }
}
const decodeComponent = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encodeComponent = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
// The colour space a drawImage source's pixels are in: an ImageBitmap's its slots', a decoded image's its
// `_colorSpace`; a <canvas> source is in its 2D context's colour space (its backing holds context-space values);
// anything else defaults to sRGB.
function sourceColorSpace(source) {
  const b = bitmapOf(source);
  if (b) return b.colorSpace;
  if (source && source._colorSpace) return source._colorSpace;
  const ctx = source && surfaceOf(source)._ctx;
  if (ctx && ctx._attrs && ctx._attrs.colorSpace) return ctx._attrs.colorSpace;
  return 'srgb';
}

// ImageBitmap (HTML §8.10.1), generated from its IDL: a decoded pixel buffer only the platform makes —
// `createImageBitmap`, `OffscreenCanvas.transferToImageBitmap`, a structured clone or a transfer — its state in its
// slots: its RGBA pixels (row-major; a wide-profile source's Display P3 rendering beside them), its size, its colour
// space, whether a cross-origin source tainted it, and whether it is closed ([[Detached]]: an unusable image source).
const bitmap = defineImageBitmap({
  init(s, pixels, width, height, { colorSpace = 'srgb', pixelsP3 = null, tainted = false } = {}) {
    Object.assign(s, { pixels, width, height, colorSpace, pixelsP3, tainted, closed: false });
  },
  get_width: (s) => s.width,
  get_height: (s) => s.height,
  close: (s) => closeBitmap(s)
});
function closeBitmap(s) {
  s.pixels = null; s.pixelsP3 = null; s.width = s.height = 0; s.closed = true;
}
export const ImageBitmap = bitmap.interface;
const BITMAP = brandKey('ImageBitmap');
const bitmapOf = (o) => slotsOf(o, BITMAP);
// …and one's structured clone (it is [Serializable]): copies of its pixels, the rest as it is — undefined for anything
// else, and a DataCloneError for a closed one ([[Detached]]). A transfer is the same clone, the source closed once the
// whole message is serialized (`closeImageBitmap`), as a message that fails to leaves it open.
export function cloneImageBitmap(v) {
  const s = bitmapOf(v);
  if (!s) return undefined;
  if (s.closed) throw new DOMException('An ImageBitmap is detached and could not be cloned.', 'DataCloneError');
  return bitmap.create(s.pixels && new Bytes(s.pixels), s.width, s.height,
    { colorSpace: s.colorSpace, pixelsP3: s.pixelsP3 && new Bytes(s.pixelsP3), tainted: s.tainted });
}
export const imageBitmapClosed = (v) => bitmapOf(v).closed;
export const closeImageBitmap = (v) => closeBitmap(bitmapOf(v));

// A <canvas> / OffscreenCanvas source — by what it is, never by asking the page's `getContext`, which would make one
// (with default settings) as it answered.
const isCanvasElement = interfaceCheck('HTMLCanvasElement');
const isCanvasSource = (src) => isCanvasElement(src) || offscreenOf(src) !== undefined;

// Whether `src` is a CanvasImageSource TYPE at all (img / canvas / video / ImageBitmap
// / VideoFrame) — regardless of whether it currently has usable pixels. drawImage of a
// recognized-but-unusable source (broken img) is a silent no-op; anything else (a <p>,
// a plain object) is a TypeError.
function isImageSourceType(src) {
  if (!src || typeof src !== 'object') return false;
  const tag = src._tag;
  if (tag === 'img' || tag === 'video' || tag === 'image') return true;   // 'image' = SVG <image>
  if (isCanvasSource(src) || bitmapOf(src) !== undefined) return true;
  return (globalThis.VideoFrame && src instanceof globalThis.VideoFrame) || false;
}

// An image source's pixels, `{pixels, width, height, pixelsP3}` — none where it has no usable ones: an ImageBitmap's
// slots', an <img>'s (decoded on `src=`, at its natural size), a canvas's bitmap, a <video>'s first decoded frame.
function resolveImagePixels(src) {
  if (!src) return null;
  const b = bitmapOf(src);
  if (b) return b.pixels && b.width && b.height ? {pixels: b.pixels, width: b.width, height: b.height, pixelsP3: b.pixelsP3} : null;
  // An <img>'s bitmap is its intrinsic (natural) size — independent of any
  // width/height content attribute, which only affects layout. Other sources
  // (canvas / ImageBitmap) size their buffer by width/height directly.
  const surface = surfaceOf(src);
  if (surface._pixels) {
    const w = src._naturalWidth != null ? src._naturalWidth : src.width;
    const h = src._naturalHeight != null ? src._naturalHeight : src.height;
    if (w && h) return {pixels: surface._pixels, width: w, height: h, pixelsP3: src._pixelsP3 || null};
  }
  // HTMLVideoElement's first-decoded frame is cached the same shape.
  const f = src._csimVideoFrame;
  if (f && f._pixels && f.width && f.height) return {pixels: f._pixels, width: f.width, height: f.height, pixelsP3: null};
  return null;
}

// Whether drawing / patterning from `src` taints the destination canvas (clears its origin-clean
// flag): a cross-origin image whose bytes aren't CORS-approved (`_tainted`, set by the image
// load), an ImageBitmap carrying that taint, or a <canvas>/OffscreenCanvas whose OWN context is
// already tainted (taint is transitive). A same-origin / CORS-approved / data: source is clean.
// A <video>'s `_tainted` is set by its fetch (opaque SW response / no-cors cross-origin
// network load — media.js decodeAndDispatch), same model as <img>.
function imageSourceTainted(src) {
  if (!src || typeof src !== 'object') return false;
  if (bitmapOf(src)?.tainted || src._tainted) return true;         // ImageBitmap / <img> / SVG <image>
  return canvasTainted(src);                                       // <canvas> / OffscreenCanvas
}

// Whether canvas `c`'s backing store is tainted — its 2D context's origin-clean flag is false.
// A canvas that never got a 2D context can't have been drawn to, so it's clean.
function canvasTainted(c) {
  const ctx = c && surfaceOf(c)._ctx;
  return !!(ctx && ctx._originClean === false);
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
        resolve(bitmap.create(out, ow, oh, {
          // A bitmap decoded from a tainted source (a cross-origin <img>/<canvas>/ImageBitmap) stays
          // tainted, so it can't launder cross-origin pixels clean back into a canvas.
          tainted: imageSourceTainted(source),
          // `colorSpaceConversion: 'none'` means don't colour-manage the source: treat
          // the decoded bytes as unmanaged (sRGB, no conversion downstream). Otherwise
          // preserve the source's colour space so a later drawImage converts correctly.
          colorSpace: options.colorSpaceConversion === 'none' ? 'srgb' : (colorSpace || sourceColorSpace(source)),
          // Carry the wide-gamut (Display-P3) rendering of a wide-profile source, but
          // only for an untransformed bitmap (crop/resize/flip would have to re-derive
          // it too, which isn't modeled — those fall back to the sRGB rendering).
          pixelsP3: p3Pixels && !fresh && options.colorSpaceConversion !== 'none' ? p3Pixels : null
        }));
      } catch (_) {
        invalid();
      }
    };

    if (isBlob(source)) {
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
    const imageData = imageDataOf(source);
    if (imageData) {
      const { bytes, colorSpace } = imageDataPixels(imageData);
      return finish(bytes, imageData.width, imageData.height, false, colorSpace);
    }
    const sourceBitmap = bitmapOf(source);
    if (sourceBitmap) {
      if (sourceBitmap.closed || !sourceBitmap.pixels) return invalid();
      return finish(sourceBitmap.pixels, sourceBitmap.width, sourceBitmap.height, false, undefined, sourceBitmap.pixelsP3);
    }
    if (isCanvasSource(source)) {
      // A <canvas> / OffscreenCanvas: zero-area is unusable; snapshot its backing buffer
      // (transparent black when nothing has been drawn). An oversized canvas' zero-fill
      // allocation throws → InvalidStateError.
      const [w, h] = bitmapSize(source);
      if (!w || !h) return invalid();
      const pixels = surfaceOf(source)._pixels;
      if (pixels) return finish(pixels, w, h, false);
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
      return finish(ip.pixels, ip.width, ip.height, false, undefined, ip.pixelsP3);
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
// CanvasGradient and CanvasPattern (HTML §4.12.5.1.8), generated from their IDL: opaque objects only a context makes,
// their state in their slots — a gradient's kind, geometry and colour stops; a pattern's tile (a snapshot of the source
// image's RGBA pixels), the axes it repeats on, its colour space and its transform.
const gradient = defineCanvasGradient({
  init(s, kind, coords) { s.kind = kind; s.c = coords; s.stops = []; },
  // addColorStop(): an offset outside [0, 1] an IndexSizeError (a non-finite one the binding's TypeError), a colour
  // that does not parse a SyntaxError. A gradient isn't associated with an element, so a `currentColor` stop resolves
  // to the initial colour, opaque black — not the canvas element's `color`.
  addColorStop(s, offset, color) {
    if (offset < 0 || offset > 1) {
      throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (${offset}) is outside the range (0.0, 1.0).`, 'IndexSizeError');
    }
    const col = parseColorRGBA(color.trim().toLowerCase() === 'currentcolor' ? 'black' : color);
    if (!col) {
      throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('${color}') could not be parsed as a color.`, 'SyntaxError');
    }
    let i = s.stops.length;                       // insert keeping offsets sorted,
    while (i > 0 && s.stops[i - 1].offset > offset) i--;   // stable for equal offsets
    s.stops.splice(i, 0, {offset, color: col});
  }
});
const GRADIENT = brandKey('CanvasGradient');
const gradientOf = (o) => slotsOf(o, GRADIENT);

// The valid createPattern repetition keywords.
const PATTERN_REPS = new globalThis.Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat']);

const pattern = defineCanvasPattern({
  init(s, pixels, w, h, repetition, colorSpace, tainted) {
    s.px = pixels; s.w = w; s.h = h; s.rep = repetition;
    s.colorSpace = colorSpace || 'srgb';   // source pixels' colour space (for the fill conversion)
    s.m = IDENTITY;                        // pattern-space transform (setTransform)
    s.tainted = tainted;                   // built from a cross-origin source: it taints what it fills
  },
  // setTransform(): the pattern sampled in a space transformed by the matrix of the 2D dictionary (a DOMMatrix's members
  // or an a–f / m11–m42 one; an inconsistent one a TypeError) — one with a non-finite member leaving it as it was.
  setTransform(s, transform) {
    const m = matrix2DInit(transform);
    if (m.every(isFinite)) s.m = m;
  }
});
const PATTERN = brandKey('CanvasPattern');
const patternOf = (o) => slotsOf(o, PATTERN);

// A fill or stroke style that is an object — a gradient or a pattern — as the rasterizer takes it (`__dom.canvasDraw`'s
// paint): a gradient's kind and geometry, then its stops; a pattern's tile size, the axes it repeats on, its colour
// space and its transform, its tile's pixels beside it, and whether it is tainted. Undefined for anything else.
function paintOf(obj) {
  const g = gradientOf(obj);
  if (g) {
    const c = g.c;
    const head = g.kind === 'linear' ? [2, c.x0, c.y0, c.x1, c.y1]
               : g.kind === 'radial' ? [3, c.x0, c.y0, c.r0, c.x1, c.y1, c.r1]
               : [4, c.a0, c.x, c.y];
    head.push(g.stops.length);
    for (const {offset, color} of g.stops) head.push(offset, color.r, color.g, color.b, color.a);
    return { data: new globalThis.Float64Array(head) };
  }
  const p = patternOf(obj);
  if (p) {
    const rep = p.rep;
    const data = new globalThis.Float64Array([5, p.w, p.h, +(rep === 'repeat' || rep === 'repeat-x'),
      +(rep === 'repeat' || rep === 'repeat-y'), +(p.colorSpace === 'display-p3'), ...p.m]);
    return { data, pixels: p.px, tainted: p.tainted };
  }
  return undefined;
}
const isPaintObject = (v) => gradientOf(v) !== undefined || patternOf(v) !== undefined;

// A path under construction — the context's current default path, and a Path2D's (the CanvasPath IDL mixin's steps):
// the arguments converted as WebIDL converts them, then handed to native (canvas_path.rs `Builder`), which keeps the
// path in `_buf` — its subpaths and current point, curves and arcs flattened on the way in — and writes it in place,
// handing back a bigger array where it outgrows this one. `ctmFn`, when given (the context's default path), is the
// CTM each point is baked through as it is added: a later transform does not move a point already in the path. A
// Path2D has none and keeps user-space points, which the consuming context's CTM maps when it paints.
const PATH_OP = {moveTo: 0, lineTo: 1, closePath: 2, rect: 3, roundRect: 4, bezierCurveTo: 5, quadraticCurveTo: 6,
                 arc: 7, ellipse: 8, arcTo: 9, reset: 10};
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);   // (…shared, a pattern's slot among them: never written)

class PathBuilder {
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

  moveTo(x, y) { this._op(PATH_OP.moveTo, +x, +y); }
  lineTo(x, y) { this._op(PATH_OP.lineTo, +x, +y); }
  closePath() { this._op(PATH_OP.closePath); }
  rect(x, y, w, h) { this._op(PATH_OP.rect, +x, +y, +w, +h); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this._op(PATH_OP.bezierCurveTo, +c1x, +c1y, +c2x, +c2y, +x, +y); }
  quadraticCurveTo(cx, cy, x, y) { this._op(PATH_OP.quadraticCurveTo, +cx, +cy, +x, +y); }
  arc(x, y, r, a0, a1, ccw) { this._op(PATH_OP.arc, +x, +y, +r, +a0, +a1, +!!ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) { this._op(PATH_OP.ellipse, +x, +y, +rx, +ry, +rot, +a0, +a1, +!!ccw); }
  arcTo(x1, y1, x2, y2, r) { this._op(PATH_OP.arcTo, +x1, +y1, +x2, +y2, +r); }
  // `radii`: `(unrestricted double or DOMPointInit or sequence<(unrestricted double or DOMPointInit)>)`, told apart as
  // WebIDL tells a union: an object (a function too) with an `@@iterator` method a sequence, each element converted as
  // it is iterated; any other object, or null, a DOMPointInit; anything else a number.
  roundRect(x, y, w, h, radii = 0) {
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

// Path2D (HTML §4.12.5.1.6), generated from its IDL: a standalone path usable with fill(path) / stroke(path) /
// clip(path) / isPointInPath(path, …), its PathBuilder in its slots — built from the CanvasPath methods, copied from
// another Path2D (any realm's), or read from SVG path data.
const pathOf = (o) => slotsOf(o, 'Path2D')?.path;
registerInterface('Path2D', (o) => pathOf(o) !== undefined);
export class Path2D {
  constructor(path) {
    [path] = convertPath2DArguments(arguments);
    const builder = new PathBuilder();
    const other = pathOf(path);
    if (other) builder._buf = other._buf.slice();
    else if (path !== undefined) builder._took(globalThis.__dom.canvasPathSvg(builder._buf, path));
    makeSlots(this, 'Path2D', { path: builder });
  }
}
installPath2D(Path2D, {
  // addPath(): another path's subpaths appended through the matrix of the 2D dictionary given (the identity where none
  // is) — nothing for a path of none, before that matrix is made (and an inconsistent one refused), nor where it has a
  // non-finite member.
  addPath(self, path, transform) {
    const added = pathOf(path);
    if (added._empty) return;
    const m = matrix2DInit(transform);
    if (!m.every(isFinite)) return;
    const builder = pathOf(self);
    builder._took(globalThis.__dom.canvasPathAdd(builder._buf, added._buf, m));
  },
  closePath: (self) => pathOf(self).closePath(),
  moveTo: (self, x, y) => pathOf(self).moveTo(x, y),
  lineTo: (self, x, y) => pathOf(self).lineTo(x, y),
  quadraticCurveTo: (self, cpx, cpy, x, y) => pathOf(self).quadraticCurveTo(cpx, cpy, x, y),
  bezierCurveTo: (self, cp1x, cp1y, cp2x, cp2y, x, y) => pathOf(self).bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y),
  arcTo: (self, x1, y1, x2, y2, radius) => pathOf(self).arcTo(x1, y1, x2, y2, radius),
  rect: (self, x, y, w, h) => pathOf(self).rect(x, y, w, h),
  roundRect: (self, x, y, w, h, radii) => pathOf(self).roundRect(x, y, w, h, radii),
  arc: (self, x, y, radius, startAngle, endAngle, counterclockwise) => pathOf(self).arc(x, y, radius, startAngle, endAngle, counterclockwise),
  ellipse: (self, x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise) =>
    pathOf(self).ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise)
});

// The 2D rendering context's engine: image blit + readback (drawImage / getImageData / putImageData) plus rectangle +
// arbitrary-path rasterization (fill / stroke / clip) through the current transform, with solid-colour and gradient
// paints, shadows, and compositing. A Path2D can be filled / stroked / clipped directly. It is no interface of its own:
// a CanvasRenderingContext2D or an OffscreenCanvasRenderingContext2D (below) keeps one in its slots, the canvas keeps it
// as its context (`_ctx`), and its members are the interface's steps, their arguments converted by the binding.
class Context2D {
  get canvas() { return this._canvas; }

  // (…`options` getContext's, converted to a CanvasRenderingContext2DSettings as the context is made: `prefix` the
  // message's)
  constructor(canvas, options, Interface, prefix) {
    this._canvas = canvas;
    this._surface = surfaceOf(canvas);
    // (…"if options is not an object, then set options to null", getContext's step before the conversion)
    const object = options !== null && (typeof options === 'object' || typeof options === 'function');
    this._attrs = toCanvasRenderingContext2DSettings(object ? options : null, prefix);
    this._rectScratch = new PathBuilder();
    this._resetState();
    this.wrapper = new Interface(PLATFORM, this);   // the interface's object, which the page holds
    this._interface = Interface.name;
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
    this._pathObj                 = new PathBuilder(() => this._m);   // default path bakes the CTM per point
  }

  // fillStyle / strokeStyle: a CanvasGradient/Pattern is stored and read back as the
  // object; a valid CSS colour is stored parsed + read back in the canvas
  // serialization; an invalid value is ignored (spec's "otherwise, do nothing").
  get fillStyle() { return this._fillObj || serializeCanvasColor(this._fill); }
  set fillStyle(v) {
    const s = this._parseStyle(v);
    if (s === undefined) return;
    if (isPaintObject(s)) { this._fillObj = s; return; }
    this._fill = s; this._fillObj = null;
  }
  get strokeStyle() { return this._strokeObj || serializeCanvasColor(this._stroke); }
  set strokeStyle(v) {
    const s = this._parseStyle(v);
    if (s === undefined) return;
    if (isPaintObject(s)) { this._strokeObj = s; return; }
    this._stroke = s; this._strokeObj = null;
  }

  // Resolve a fillStyle / strokeStyle assignment — a gradient, a pattern, or a string (the binding's union) — to the
  // gradient/pattern, a parsed {r,g,b,a} colour, or `undefined` (invalid → keep the previous style).
  _parseStyle(v) {
    if (isPaintObject(v)) return v;
    return parseColorRGBA(v, this._currentColor()) || undefined;
  }
  get shadowColor() { return serializeCanvasColor(this._shadow); }
  set shadowColor(v) { const c = parseColorRGBA(v, this._currentColor()); if (c) this._shadow = c; }

  // The CSS `currentColor` value: the canvas element's computed `color` (a detached
  // canvas / OffscreenCanvas has no element, so it falls back to the initial black).
  // Passed to parseColorRGBA so `currentColor` — top-level or nested in color-mix() /
  // a relative colour — resolves at assignment time.
  _currentColor() {
    try {
      const el = this.canvas;
      if (el && el.isConnected && globalThis.__csimGetComputedStyle) {
        const col = globalThis.__csimGetComputedStyle(el).color;
        if (col) return col;
      }
    } catch (_) { /* fall through to the initial value */ }
    return 'black';
  }

  // Shadow geometry: per spec the setters IGNORE a value that is negative (blur
  // only) or non-finite, keeping the previous one — a raw Infinity would hang the
  // blur and a NaN would wipe the canvas.
  get shadowBlur() { return this._shadowBlur; }
  set shadowBlur(v) { if (isFinite(v) && v >= 0) this._shadowBlur = v; }
  get shadowOffsetX() { return this._shadowOffsetX; }
  set shadowOffsetX(v) { if (isFinite(v)) this._shadowOffsetX = v; }
  get shadowOffsetY() { return this._shadowOffsetY; }
  set shadowOffsetY(v) { if (isFinite(v)) this._shadowOffsetY = v; }

  // Line-style IDL: the setters ignore an out-of-range value (keeping the previous),
  // per the CanvasPathDrawingStyles spec. lineWidth / miterLimit take a positive
  // finite number (zero, negative, Infinity, NaN ignored); lineCap / lineJoin take
  // one of their enum keywords (any other string, wrong case, trailing NUL ignored).
  get lineWidth()  { return this._lineWidth; }
  set lineWidth(v) { if (isFinite(v) && v > 0) this._lineWidth = v; }
  get miterLimit()  { return this._miterLimit; }
  set miterLimit(v) { if (isFinite(v) && v > 0) this._miterLimit = v; }
  get lineCap()  { return this._lineCap; }
  set lineCap(v) { if (v === 'butt' || v === 'round' || v === 'square') this._lineCap = v; }
  get lineJoin()  { return this._lineJoin; }
  set lineJoin(v) { if (v === 'round' || v === 'bevel' || v === 'miter') this._lineJoin = v; }
  get lineDashOffset()  { return this._lineDashOffset; }
  set lineDashOffset(v) { if (isFinite(v)) this._lineDashOffset = v; }
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
  set letterSpacing(v) { const p = globalThis.__dom.canvasSpacing(v, NaN, NaN); if (p) this._letterSpacing = p[0]; }
  get wordSpacing()  { return this._wordSpacing; }
  set wordSpacing(v) { const p = globalThis.__dom.canvasSpacing(v, NaN, NaN); if (p) this._wordSpacing = p[0]; }
  // font: on getting, the canonical serialized shorthand; on setting, parse-and-ignore
  // an unparsable value (keep the previous), resolving the size to px at assignment.
  get font()  { return this._fontParts[0]; }
  set font(v) { const f = this._computeFont(v); if (f) this._fontParts = f; }

  // globalAlpha: the setter ignores a value outside [0, 1] or non-finite (keeps the
  // previous), per spec.
  get globalAlpha()  { return this._globalAlpha; }
  set globalAlpha(v) { if (isFinite(v) && v >= 0 && v <= 1) this._globalAlpha = v; }

  // globalCompositeOperation: the setter ignores an unknown value (keeps the
  // previous), per spec.
  get globalCompositeOperation() { return this._gco; }
  set globalCompositeOperation(v) { if (KNOWN_GCO.has(v)) this._gco = v; }

  // (…their coordinates doubles, a non-finite one the binding's TypeError)
  createLinearGradient(x0, y0, x1, y1) {
    return gradient.create('linear', {x0, y0, x1, y1});
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (r0 < 0 || r1 < 0) throw new globalThis.DOMException('negative radius', 'IndexSizeError');
    return gradient.create('radial', {x0, y0, r0, x1, y1, r1});
  }
  createConicGradient(startAngle, x, y) {
    return gradient.create('conic', {a0: startAngle, x, y});
  }

  // createPattern(image, repetition): a tiled-image fill/stroke style. An empty repetition (null too, by the binding's
  // [LegacyNullToEmptyString]) is 'repeat'; any other non-keyword (including `undefined` → "undefined") is a
  // SyntaxError. Image usability (HTML "check the usability of the image argument") decides the rest: a still-loading /
  // srcless / zero-size <img> yields `null`; a BROKEN <img> (a request that failed) or a zero-area canvas throws
  // InvalidStateError.
  createPattern(image, repetition) {
    if (bitmapOf(image)?.closed) throw new DOMException(this._failure('createPattern') + 'The image source is detached.', 'InvalidStateError');
    if (repetition === '') repetition = 'repeat';
    if (!PATTERN_REPS.has(repetition)) throw new globalThis.DOMException('bad repetition', 'SyntaxError');
    // A pattern built from a cross-origin (non-CORS-approved) source is itself tainted — painting
    // with it later taints whatever canvas it fills (pattern-from-{img,image,canvas}-cross-origin).
    const tainted = imageSourceTainted(image);
    const src = resolveImagePixels(image);
    if (src) {
      // A wide-profile source used in a P3 context tiles from its preserved P3 rendering.
      const useP3 = this._attrs.colorSpace === 'display-p3' && src.pixelsP3;
      const px = useP3 ? src.pixelsP3 : src.pixels;
      const cs = useP3 ? 'display-p3' : sourceColorSpace(image);
      // Snapshot the source pixels — a later draw to a live source canvas must not
      // change the pattern.
      return pattern.create(new globalThis.Uint8ClampedArray(px), src.width, src.height, repetition, cs, tainted);
    }
    if (isCanvasSource(image)) {
      const [w, h] = bitmapSize(image);
      if (!w || !h) throw new globalThis.DOMException('the canvas has zero size', 'InvalidStateError');
      const px = surfaceOf(image)._pixels || new globalThis.Uint8ClampedArray(w * h * 4);   // blank canvas → transparent tile
      return pattern.create(new globalThis.Uint8ClampedArray(px), w, h, repetition, sourceColorSpace(image), tainted);
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
  // setLineDash(segments): if any segment is negative or non-finite the whole call is ignored (the dash list is
  // unchanged). An odd-length list is duplicated so the on/off pattern is well defined.
  setLineDash(segments) {
    if (!segments.every((v) => isFinite(v) && v >= 0)) return;
    this._lineDash = segments.length % 2 ? segments.concat(segments) : segments;
  }
  getLineDash() { return this._lineDash.slice(); }

  // Transform stack. Each mutates the current transform matrix (CTM); rect fills
  // map their corners through it, so translate / scale / rotate all take effect.
  // Per spec every transform method is a no-op when any argument is non-finite
  // (NaN / ±Infinity) — the prior matrix is preserved rather than poisoned.
  translate(x, y) { if (allFinite(x, y)) this._m = mulMatrix(this._m, [1, 0, 0, 1, x, y]); }
  scale(x, y)     { if (allFinite(x, y)) this._m = mulMatrix(this._m, [x, 0, 0, y, 0, 0]); }
  rotate(rad) {
    if (!allFinite(rad)) return;
    const c = Math.cos(rad), s = Math.sin(rad);
    this._m = mulMatrix(this._m, [c, s, -s, c, 0, 0]);
  }
  transform(a, b, c, d, e, f) {
    if (allFinite(a, b, c, d, e, f)) this._m = mulMatrix(this._m, [a, b, c, d, e, f]);
  }
  // setTransform(a, b, c, d, e, f) — replace the CTM with those components (a non-finite one leaving it) — and
  // setTransform(transform), with the matrix of the 2D dictionary (the identity where none is given).
  setTransform(a, b, c, d, e, f) {
    if (allFinite(a, b, c, d, e, f)) this._m = [a, b, c, d, e, f];
  }
  setTransformMatrix(transform) {
    const m = matrix2DInit(transform);
    if (m.every(isFinite)) this._m = m;
  }
  // getTransform() — the current CTM as a fresh (2D) DOMMatrix.
  getTransform() {
    const m = this._m;
    return new globalThis.DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
  }
  resetTransform() { this._m = [1, 0, 0, 1, 0, 0]; }

  // ── Path building ───────────────────────────────────────────────────────
  // The current default path lives in a PathBuilder (as a Path2D's does); the
  // building methods delegate to it. beginPath() replaces it with a fresh one.
  beginPath() { this._pathObj.reset(); }
  moveTo(x, y) { this._pathObj.moveTo(x, y); }
  lineTo(x, y) { this._pathObj.lineTo(x, y); }
  closePath() { this._pathObj.closePath(); }
  rect(x, y, w, h) { this._pathObj.rect(x, y, w, h); }
  roundRect(x, y, w, h, radii) { this._pathObj.roundRect(x, y, w, h, radii); }
  bezierCurveTo(a, b, c, d, e, f) { this._pathObj.bezierCurveTo(a, b, c, d, e, f); }
  quadraticCurveTo(a, b, c, d) { this._pathObj.quadraticCurveTo(a, b, c, d); }
  arc(a, b, c, d, e, f) { this._pathObj.arc(a, b, c, d, e, f); }
  ellipse(a, b, c, d, e, f, g, h) { this._pathObj.ellipse(a, b, c, d, e, f, g, h); }
  arcTo(a, b, c, d, e) { this._pathObj.arcTo(a, b, c, d, e); }

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
    const [cw, ch] = bitmapSize(this.canvas);
    if (!cw || !ch) return null;
    if (!this._surface._pixels) this._surface._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    return this._surface._pixels;
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
      ...bitmapSize(this.canvas), plain ? 1 : this.globalAlpha, m[0], m[1], m[2], m[3], m[4], m[5],
      +(this._attrs.colorSpace === 'display-p3'), sh.r, sh.g, sh.b, plain ? 0 : sh.a,
      this.shadowBlur, this.shadowOffsetX, this.shadowOffsetY,
    ]);
    globalThis.__dom.canvasDraw(buf, this._clip, shape, paint.mask || null, paint.data, paint.pixels || null, state,
                                plain ? 'source-over' : this._gco);
  }
  // The paint of a fill / stroke style — a gradient, a pattern, or the solid colour — as `_draw` takes it. Painting
  // with a tainted pattern (createPattern of a cross-origin source) taints this canvas.
  _paintOf(obj, solid) {
    const paint = obj && paintOf(obj);
    if (paint) {
      if (paint.tainted) this._originClean = false;
      return paint;
    }
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

  // The draw-path operations take the path given — a Path2D's PathBuilder — or null for the current default path.
  //
  // fill([path,] fillRule): rasterize the path, subpaths implicitly closed, under the winding rule.
  fill(path, fillRule) {
    path ??= this._pathObj;
    if (!path._empty) this._draw(this._fillShape(path, fillRule === 'evenodd'), this._paintOf(this._fillObj, this._fill));
  }

  // stroke([path]): the path thickened by the pen (lineWidth, lineCap / lineJoin, the dash pattern) and painted in one
  // nonzero pass — the union covers overlaps exactly once, so a translucent strokeStyle doesn't darken at corners.
  stroke(path) {
    path ??= this._pathObj;
    if (!path._empty) this._draw(this._strokeShape(path, this.lineWidth), this._paintOf(this._strokeObj, this._stroke));
  }

  // clip([path,] fillRule): intersect the clip region with the path, so subsequent draws are masked
  // (`__dom.canvasClip` fills the mask: a pixel is inside where it is at least half covered). Part of the drawing
  // state (save/restore'd); clip() only ever shrinks the region.
  clip(path, fillRule) {
    path ??= this._pathObj;
    const [cw, ch] = bitmapSize(this.canvas);
    if (!cw || !ch) return;
    const mask = new globalThis.Uint8Array(cw * ch);   // (…a canvas too large for one is a RangeError here)
    globalThis.__dom.canvasClip(mask, cw, ch, this._fillShape(path, fillRule === 'evenodd'), this._clip);
    this._clip = mask;
  }

  // isPointInPath([path,] x, y, fillRule) — is the point, in canvas coordinate space (unaffected by the current
  // transform), inside the path under the winding rule, as fill() would paint it (`__dom.canvasHit`)? A point exactly
  // on the boundary is inside; under a non-invertible CTM nothing is.
  isPointInPath(path, x, y, fillRule) {
    return globalThis.__dom.canvasHit(this._fillShape(path ?? this._pathObj, fillRule === 'evenodd'), x, y);
  }

  // isPointInStroke([path,] x, y) — is the point (in canvas coordinate space) on the stroke? Tested against the stroke
  // stroke() would paint, so caps, joins, a non-uniform pen and the dash pattern are all honoured exactly (a point just
  // past a butt-capped dash end is outside).
  isPointInStroke(path, x, y) {
    return globalThis.__dom.canvasHit(this._strokeShape(path ?? this._pathObj, this.lineWidth), x, y);
  }

  // Reset the bitmap to transparent black and the context to its default state.
  reset() { this._surface._pixels = null; this._resetState(); }
  // (…the dictionary its settings were converted to, its members in their name's order)
  getContextAttributes() { return { ...this._attrs }; }
  isContextLost() { return false; }
  // drawFocusIfNeeded([path,] element): if `element` is focused and is fallback
  // content of this canvas, draw a focus ring along the path — so keyboard / AT users
  // can see which control the path represents. A real UA paints a platform-styled ring;
  // we stroke a 2px opaque outline of the path, which satisfies the observable contract
  // (the canvas changes only when the associated element is actually focused).
  drawFocusIfNeeded(path, element) {
    path ??= this._pathObj;
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
    if (!el || el._nodeType !== 1 || !globalThis.__csimGetComputedStyle) return null;
    let fs = defaultFs, lh = NaN;
    try {
      const cs = globalThis.__csimGetComputedStyle(el);
      if (el.isConnected) fs = parseFloat(cs.fontSize) || defaultFs;
      lh = parseFloat(cs.lineHeight);   // (…px, or `normal`)
    } catch (_) { /* fall through */ }
    return {fs, lh: lh > 0 ? lh : fs * 1.2};
  }
  // …the root's, for `rem` / `rlh`.
  _rootBase() {
    const doc = this.canvas && this.canvas.ownerDocument;
    return this._fontBase(doc && documentElementOf(doc), 16);
  }

  // A CSS `font` shorthand computed (spec: at assignment time), or null if it does not parse — the style engine's,
  // `__dom.canvasFont`: `[serialization, px, weight, slant, smallCaps, firstFamily]`, its size in px, `em` / `%` of the
  // canvas element's font size, `rem` of the root's, `lh` / `rlh` of their line heights. A lone system-font keyword is
  // the platform UI font, which is not modelled: one concrete default stands for all.
  _computeFont(input) {
    const raw = input.trim();
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
    text = text.replace(CANVAS_TEXT_WS, ' ');
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

  fillText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this._fillObj, this._fill); }
  // strokeText is approximated as a filled glyph (glyph-outline stroking isn't
  // modeled) — the common use is a visible label; the fill/stroke colour differs.
  strokeText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this._strokeObj, this._stroke); }

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
    text = text.replace(CANVAS_TEXT_WS, ' ');
    if (!text || !allFinite(x, y)) return;
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
    const [w, h] = bitmapSize(this.canvas), shadow = this._shadow.a > 0;
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
      if (el && el._nodeType === 1 && globalThis.__csimGetComputedStyle) {
        dir = globalThis.__csimGetComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
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
    if (!allFinite(x, y, w, h) || !w || !h) return;
    this._draw(this._rectShape(x, y, w, h), this._paintOf(this._fillObj, this._fill));
  }

  // clearRect ignores fillStyle / globalAlpha and casts NO shadow — it clears the covered pixels (a partly covered
  // edge in proportion), inside the clip.
  clearRect(x, y, w, h) {
    if (!allFinite(x, y, w, h) || !w || !h) return;
    this._draw(this._rectShape(x, y, w, h), { data: new globalThis.Float64Array([1]) });
  }

  // strokeRect strokes the rectangle's closed path, exactly as stroke() would: its four corners honor lineJoin /
  // miterLimit, a degenerate (zero-w/-h) rect strokes as the line it is, and the stroke scales / rotates with the CTM.
  strokeRect(x, y, w, h) {
    if (!allFinite(x, y, w, h) || (!w && !h)) return;
    this._draw(this._strokeShape(this._rectPath(x, y, w, h), this.lineWidth), this._paintOf(this._strokeObj, this._stroke));
  }

  // drawImage(): `source` a CanvasImageSource (the binding's union), drawn from its rectangle (sx, sy, sw, sh) to
  // (dx, dy, dw, dh) — the sizes it does not give its own.
  drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (bitmapOf(source)?.closed) throw new DOMException(this._failure('drawImage') + 'The image source is detached.', 'InvalidStateError');
    let src = resolveImagePixels(source);
    if (!src && isCanvasSource(source)) {
      // A canvas source with a zero dimension is an InvalidStateError; a blank (undrawn)
      // but sized canvas is a fully-transparent image — it must still DRAW (as transparent
      // pixels), not no-op, so a whole-canvas operator (source-in / copy / …) clears the
      // destination it isn't covering.
      const [w, h] = bitmapSize(source);
      if (!w || !h) throw new globalThis.DOMException('the source canvas has zero size', 'InvalidStateError');
      src = {pixels: new globalThis.Uint8ClampedArray(w * h * 4), width: w, height: h};
    }
    // A recognized but unusable source (broken / not-yet-loaded / srcless image) draws nothing — our synchronous
    // decode can't tell a failed request from one still loading, so we don't throw the spec's broken-image
    // InvalidStateError (it would break drawing a still-loading image, which must be a no-op).
    if (!src) return;
    // A usable but cross-origin (non-CORS-approved) source taints this canvas — even a
    // geometrically-clipped or off-canvas draw, per spec (the source's pixels became reachable).
    if (imageSourceTainted(source)) this._originClean = false;
    // A wide-profile (Adobe/CMYK) source carries a separate Display-P3 rendering — use it (not the clipped sRGB one)
    // when drawing into a P3 canvas, so its wide colours survive. The rasterizer brings the source into this canvas's
    // colour space (on its own copy, which also keeps a canvas drawn onto itself reading its pixels from before).
    let srcCS = sourceColorSpace(source);
    if (this._attrs.colorSpace === 'display-p3' && src.pixelsP3) {
      src = { pixels: src.pixelsP3, width: src.width, height: src.height };
      srcCS = 'display-p3';
    }
    const iw = src.width, ih = src.height;
    sw ??= iw; sh ??= ih; dw ??= iw; dh ??= ih;
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
    const prefix = this._failure('getImageData');
    if (w === 0 || h === 0) throw new globalThis.DOMException('getImageData: width or height is zero', 'IndexSizeError');
    if (w < 0) { x += w; w = -w; }   // a negative extent normalizes the rect (spec)
    if (h < 0) { y += h; h = -h; }
    // A tainted canvas can't be read back — reading a cross-origin image's pixels is the leak the
    // origin-clean flag exists to prevent (getImageData "if not origin-clean, throw SecurityError").
    if (!this._originClean) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    assertImageArea(w, h, pixelArray(settings.pixelFormat).BYTES_PER_ELEMENT, prefix);
    const [cw, ch] = bitmapSize(this.canvas);
    const out = new Bytes(w * h * 4);
    const src = this._surface._pixels;
    if (src) blitRGBA(src, cw, ch, x, y, w, h, out, w, h, 0, 0, w, h);
    // The backing holds values in this context's colour space, read back in the one the settings ask for — the
    // context's where they name none. `out` is a fresh copy, so this doesn't touch the backing store.
    return imageDataFromPixels(out, w, h, this._attrs.colorSpace, settings, this._attrs.colorSpace);
  }

  // putImageData(): an ImageData's (`image` its slots) dirty rectangle — the whole of it where none is given — put at
  // (dx, dy); one whose array's buffer is detached an InvalidStateError.
  putImageData(image, dx, dy, drX, drY, drW, drH) {
    if (bufferSourceByteLength(image.data) === 0) throw new globalThis.DOMException(this._failure('putImageData') + 'The source data has been detached.', 'InvalidStateError');
    const [cw, ch] = bitmapSize(this.canvas);
    if (!cw || !ch) return;
    if (!this._surface._pixels) this._surface._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    const iw = image.width, ih = image.height;
    if (drW < 0) { drX += drW; drW = -drW; }   // a negative dirty extent normalizes
    if (drH < 0) { drY += drH; drH = -drH; }
    // Convert the ImageData into this context's colour space before writing it to
    // the backing (on a copy, so the caller's buffer is untouched).
    let { bytes: srcData, colorSpace } = imageDataPixels(image);
    if (colorSpace !== this._attrs.colorSpace) {
      srcData = convertColorSpace(srcData === image.data ? new Bytes(srcData) : srcData, colorSpace, this._attrs.colorSpace);
    }
    blitRGBA(srcData, iw, ih, drX, drY, drW, drH,
             this._surface._pixels, cw, ch, dx + drX, dy + drY, drW, drH);
  }

  // createImageData(): a new ImageData of transparent black — the absolute magnitude of the size given, and its
  // settings, in this context's colour space where they name none — and createImageDataLike(), of the size and settings
  // of an ImageData (`image` its slots).
  createImageData(sw, sh, settings) {
    const w = Math.abs(sw), h = Math.abs(sh);
    if (w === 0 || h === 0) throw new globalThis.DOMException(this._failure('createImageData') + 'The source width or height is zero.', 'IndexSizeError');
    return this._blankImageData(w, h, settings);
  }
  createImageDataLike(image) {
    return this._blankImageData(image.width, image.height, { colorSpace: image.colorSpace, pixelFormat: image.pixelFormat });
  }
  _blankImageData(w, h, settings) {
    assertImageArea(w, h, pixelArray(settings.pixelFormat).BYTES_PER_ELEMENT, this._failure('createImageData'));
    return imageDataFromPixels(new Bytes(w * h * 4), w, h, this._attrs.colorSpace, settings, this._attrs.colorSpace);
  }
  // An exception's message prefix for an operation of this context's interface (Chrome's).
  _failure(op) { return `Failed to execute '${op}' on '${this._interface}': `; }
}

// CanvasRenderingContext2D (HTML §4.12.5.1) and OffscreenCanvasRenderingContext2D (§4.12.5.3), generated from their
// IDL: made by the platform alone (a canvas's getContext), the engine in their slots and every member that engine's —
// the binding resolving the overloads and converting the arguments. (The offscreen one has the same members but the
// focus ring's, drawFocusIfNeeded, and its `canvas` is an OffscreenCanvas.)
const engineOf = (o) => slotsOf(o, 'CanvasRenderingContext2D')?.engine;
registerInterface('CanvasRenderingContext2D', (o) => engineOf(o) !== undefined);
export class CanvasRenderingContext2D {
  constructor(token, engine) {
    constructedBy(PLATFORM, token, 'CanvasRenderingContext2D');
    makeSlots(this, 'CanvasRenderingContext2D', { engine });
  }
}
const offscreenEngineOf = (o) => slotsOf(o, 'OffscreenCanvasRenderingContext2D')?.engine;
registerInterface('OffscreenCanvasRenderingContext2D', (o) => offscreenEngineOf(o) !== undefined);
export class OffscreenCanvasRenderingContext2D {
  constructor(token, engine) {
    constructedBy(PLATFORM, token, 'OffscreenCanvasRenderingContext2D');
    makeSlots(this, 'OffscreenCanvasRenderingContext2D', { engine });
  }
}
// (…an attribute the engine's own accessor, an operation its method — an overload's its own entry, the path it takes
// that Path2D's PathBuilder, or null for the current default path)
const CONTEXT_ATTRIBUTES = [
  'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'strokeStyle', 'fillStyle',
  'shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor', 'filter', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
  'lineDashOffset', 'lang', 'font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'fontKerning',
  'fontStretch', 'fontVariantCaps', 'textRendering', 'wordSpacing'
];
const CONTEXT_OPERATIONS = [
  'getContextAttributes', 'save', 'restore', 'reset', 'isContextLost', 'scale', 'rotate', 'translate', 'transform',
  'getTransform', 'resetTransform', 'createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern',
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'fillText', 'strokeText', 'measureText', 'getImageData',
  'setLineDash', 'getLineDash', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'rect',
  'roundRect', 'arc', 'ellipse'
];
function contextImpl(engineOf) {
  const impl = {
    get_canvas: (c) => engineOf(c).canvas,
    setTransform_transform: (c, transform) => engineOf(c).setTransformMatrix(transform),
    setTransform_a_b_c_d_e_f: (c, a, b, d, e, f, g) => engineOf(c).setTransform(a, b, d, e, f, g),
    fill_fillRule: (c, fillRule) => engineOf(c).fill(null, fillRule),
    fill_path_fillRule: (c, path, fillRule) => engineOf(c).fill(pathOf(path), fillRule),
    stroke_none: (c) => engineOf(c).stroke(null),
    stroke_path: (c, path) => engineOf(c).stroke(pathOf(path)),
    clip_fillRule: (c, fillRule) => engineOf(c).clip(null, fillRule),
    clip_path_fillRule: (c, path, fillRule) => engineOf(c).clip(pathOf(path), fillRule),
    isPointInPath_x_y_fillRule: (c, x, y, fillRule) => engineOf(c).isPointInPath(null, x, y, fillRule),
    isPointInPath_path_x_y_fillRule: (c, path, x, y, fillRule) => engineOf(c).isPointInPath(pathOf(path), x, y, fillRule),
    isPointInStroke_x_y: (c, x, y) => engineOf(c).isPointInStroke(null, x, y),
    isPointInStroke_path_x_y: (c, path, x, y) => engineOf(c).isPointInStroke(pathOf(path), x, y),
    drawFocusIfNeeded_element: (c, element) => engineOf(c).drawFocusIfNeeded(null, element),
    drawFocusIfNeeded_path_element: (c, path, element) => engineOf(c).drawFocusIfNeeded(pathOf(path), element),
    drawImage_image_dx_dy: (c, image, dx, dy) => engineOf(c).drawImage(image, 0, 0, undefined, undefined, dx, dy),
    drawImage_image_dx_dy_dw_dh: (c, image, dx, dy, dw, dh) =>
      engineOf(c).drawImage(image, 0, 0, undefined, undefined, dx, dy, dw, dh),
    drawImage_image_sx_sy_sw_sh_dx_dy_dw_dh: (c, image, sx, sy, sw, sh, dx, dy, dw, dh) =>
      engineOf(c).drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh),
    createImageData_imageData: (c, imageData) => engineOf(c).createImageDataLike(imageDataOf(imageData)),
    createImageData_sw_sh_settings: (c, sw, sh, settings) => engineOf(c).createImageData(sw, sh, settings),
    putImageData_imageData_dx_dy(c, imageData, dx, dy) {
      const image = imageDataOf(imageData);
      engineOf(c).putImageData(image, dx, dy, 0, 0, image.width, image.height);
    },
    putImageData_imageData_dx_dy_dirtyX_dirtyY_dirtyWidth_dirtyHeight: (c, imageData, dx, dy, x, y, w, h) =>
      engineOf(c).putImageData(imageDataOf(imageData), dx, dy, x, y, w, h)
  };
  for (const name of CONTEXT_ATTRIBUTES) {
    impl[`get_${name}`] = (c) => engineOf(c)[name];
    impl[`set_${name}`] = (c, v) => { engineOf(c)[name] = v; };
  }
  for (const name of CONTEXT_OPERATIONS) impl[name] = forward(engineOf, name);
  return impl;
}
// A context operation handed to its engine's method with the arguments the binding passes — as many as the operation
// declares, an omitted optional one undefined — without a rest array's allocation on the path-building calls a drawing
// loop makes by the thousand.
function forward(engineOf, method) {
  return function (c, a, b, d, e, f, g, h, i) {
    const engine = engineOf(c);
    switch (arguments.length) {
      case 1: return engine[method]();
      case 2: return engine[method](a);
      case 3: return engine[method](a, b);
      case 4: return engine[method](a, b, d);
      case 5: return engine[method](a, b, d, e);
      case 6: return engine[method](a, b, d, e, f);
      case 7: return engine[method](a, b, d, e, f, g);
      default: return engine[method](a, b, d, e, f, g, h, i);
    }
  };
}
installCanvasRenderingContext2D(CanvasRenderingContext2D, contextImpl(engineOf));
installOffscreenCanvasRenderingContext2D(OffscreenCanvasRenderingContext2D, contextImpl(offscreenEngineOf));

// OffscreenCanvas (HTML §4.12.5.3), generated from its IDL: an EventTarget its size, its bitmap and its context in its
// slots — the bitmap and context under the names a <canvas> element keeps its own by, so one `surfaceOf` serves both.
const offscreenOf = (o) => slotsOf(o, 'OffscreenCanvas');
registerInterface('OffscreenCanvas', (o) => offscreenOf(o) !== undefined);
export class OffscreenCanvas extends EventTarget {
  constructor(width, height) {
    [width, height] = convertOffscreenCanvasArguments(arguments);
    super();
    makeSlots(this, 'OffscreenCanvas', { width, height, _pixels: null, _ctx: null, detached: false });
  }
}
// A canvas's bitmap and context: an OffscreenCanvas's slots, a <canvas> element's own.
const surfaceOf = (canvas) => offscreenOf(canvas) ?? canvas;
// …and its bitmap's size: its width and height, or none where no bitmap of that size can be allocated (as a browser,
// which draws nothing into one) — a size an [EnforceRange] unsigned long long admits, past any typed array.
function bitmapSize(canvas) {
  const w = canvas.width, h = canvas.height;
  return w * h * 4 > MAX_IMAGE_BYTES ? [0, 0] : [w, h];
}
// A canvas's bitmap reset to transparent black (sized anew) and its 2D context's state (transform, clip, styles) — an
// OffscreenCanvas's width or height assigned, a <canvas>'s `width` / `height` attribute set (dom-nodes.js), even to the
// value it had: the `canvas.width = canvas.width` clear idiom.
export function resetBitmap(surface) {
  surface._pixels = null;
  if (surface._ctx) surface._ctx._resetState();
}
function resize(s, dimension, v) {
  s[dimension] = v;
  resetBitmap(s);
}
installOffscreenCanvas(OffscreenCanvas, {
  get_width: (canvas) => offscreenOf(canvas).width,
  set_width: (canvas, v) => resize(offscreenOf(canvas), 'width', v),
  get_height: (canvas) => offscreenOf(canvas).height,
  set_height: (canvas, v) => resize(offscreenOf(canvas), 'height', v),
  // getContext(): its 2D context, made the first time — no other kind is modelled (a "bitmaprenderer" one, WebGL,
  // WebGPU), so null for any other, as for one asked of a canvas whose context is of another kind.
  getContext(canvas, contextId, options) {
    const s = offscreenOf(canvas);
    detachedCheck(s, 'getContext');
    if (contextId !== '2d') return null;
    s._ctx ??= new Context2D(canvas, options, OffscreenCanvasRenderingContext2D, "Failed to execute 'getContext' on 'OffscreenCanvas': ");
    return s._ctx.wrapper;
  },
  // transferToImageBitmap(): its bitmap as an ImageBitmap (inheriting its origin-clean flag), and its own reset to
  // transparent black — an InvalidStateError for one with no context.
  transferToImageBitmap(canvas) {
    const s = offscreenOf(canvas);
    detachedCheck(s, 'transferToImageBitmap');
    if (!s._ctx) throw new DOMException("Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas': Cannot transfer an ImageBitmap from an OffscreenCanvas with no context", 'InvalidStateError');
    const bm = bitmap.create(s._pixels && new Bytes(s._pixels), s.width, s.height,
      { colorSpace: sourceColorSpace(canvas), tainted: canvasTainted(canvas) });
    s._pixels = null;
    return bm;
  },
  // convertToBlob(): a tainted bitmap and one with no pixels reject at once, in that order; the bitmap is serialised
  // at the call, and the promise settled in a task: with the Blob, or an EncodingError.
  convertToBlob(canvas, options) {
    const s = offscreenOf(canvas);
    detachedCheck(s, 'convertToBlob');
    if (canvasTainted(canvas)) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    if (!s.width || !s.height) throw new DOMException('The canvas has no pixels.', 'IndexSizeError');
    const blob = canvasEncodeBlob(canvas, options.type, options.quality ?? NaN);
    return new Promise((resolve, reject) => globalThis.__csimSetTimeout(() => {
      if (blob) resolve(blob);
      else reject(new DOMException('The bitmap could not be encoded.', 'EncodingError'));
    }, 0));
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
// (…one transferred away is detached: what it was asked to do is an InvalidStateError)
function detachedCheck(s, op) {
  if (s.detached) throw new DOMException(`Failed to execute '${op}' on 'OffscreenCanvas': The OffscreenCanvas is detached.`, 'InvalidStateError');
}
// …and its transfer (it is [Transferable]): refused for one detached already (a DataCloneError) or with a context (an
// InvalidStateError, its transfer steps'); then a new one of its size, a bitmap of transparent black — the source
// detached, its bitmap unset, once the whole message is serialized (`detachOffscreenCanvas`).
export function checkOffscreenCanvasTransfer(v) {
  const s = offscreenOf(v);
  if (s.detached) throw new DOMException('An OffscreenCanvas could not be transferred because it was detached.', 'DataCloneError');
  if (s._ctx) throw new DOMException('An OffscreenCanvas could not be transferred because it had a rendering context.', 'InvalidStateError');
}
export const transferredOffscreenCanvas = (v) => new OffscreenCanvas(offscreenOf(v).width, offscreenOf(v).height);
export function detachOffscreenCanvas(v) {
  Object.assign(offscreenOf(v), { detached: true, width: 0, height: 0, _pixels: null });
}

// The canvas's bitmap serialised as an image file (`__dom.encodeImage`) in its own colour space: `[mime, bytes]`, the
// type it was written as (an unsupported type is PNG) — or null for a canvas with no pixels, or a size the format
// cannot hold. A sized canvas never drawn on is transparent black: a browser always backs one. `type` is a string and
// `quality` a number already, NaN for none.
function encodeBitmap(canvas, type, quality) {
  const [w, h] = bitmapSize(canvas);
  if (!w || !h) return null;
  const pixels = surfaceOf(canvas)._pixels || new globalThis.Uint8ClampedArray(w * h * 4);
  return globalThis.__dom.encodeImage(pixels, w, h, type, quality, sourceColorSpace(canvas)) || null;
}
// toBlob / toDataURL's `quality` (`any`: only a Number is one, NaN for none).
const qualityOf = (quality) => typeof quality === 'number' ? quality : NaN;
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

// HTMLCanvasElement's members (HTML §4.12.5), as dom-class-aliases.js installs them with the generated binding: its
// width and height (unsigned long, 300 × 150 by default — the attributes' change steps reset its bitmap), its 2D
// context — the engine, its interface's object `wrapper`; no other kind of context is modelled (a "bitmaprenderer" one,
// WebGL, WebGPU), so null for any other — and its bitmap serialised.
export const htmlCanvasElementMembers = {
  get_width: (canvas) => reflectNumber(canvas, 'width', UNSIGNED, 300, 0, 0),
  set_width: (canvas, value) => setReflectedNumber(canvas, 'width', UNSIGNED, 300, value),
  get_height: (canvas) => reflectNumber(canvas, 'height', UNSIGNED, 150, 0, 0),
  set_height: (canvas, value) => setReflectedNumber(canvas, 'height', UNSIGNED, 150, value),
  getContext(canvas, type, options) {
    if (type !== '2d') return null;
    canvas._ctx = canvas._ctx || new Context2D(canvas, options, CanvasRenderingContext2D, "Failed to execute 'getContext' on 'HTMLCanvasElement': ");
    return canvas._ctx.wrapper;
  },
  // (…a tainted canvas throws; the bitmap is serialised NOW — the spec serialises a copy taken at the call, so a draw
  // after it is not in the file — and the callback invoked with the Blob, or null, in a task, an exception it throws
  // reported)
  toBlob(canvas, callback, type, quality) {
    if (canvasTainted(canvas)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    const blob = canvasEncodeBlob(canvas, type, qualityOf(quality));
    globalThis.__csimSetTimeout(() => callback(blob), 0);
  },
  toDataURL(canvas, type, quality) {
    if (canvasTainted(canvas)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    return canvasToDataURL(canvas, type, qualityOf(quality));
  }
};

// An ImageBitmap's, an ImageData's or a transferred OffscreenCanvas's serialization across isolates (a worker's
// postMessage, whose message is JSON): its state, its pixels a byte view the message's encoding carries — undefined for
// anything else, and a DataCloneError for an OffscreenCanvas not being transferred (`transferSet` the message's) — and
// the object again, in the receiving realm; a transferable's checks before the message is serialized, and its source
// detached after. Hooks, as the encoding's module (workers.js) is in an import cycle with this one.
const byteView = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const fromByteView = (v) => v && new Bytes(v.buffer, v.byteOffset, v.byteLength);
globalThis.__csimCanvasSerialization = {
  record(v, transferSet) {
    const b = bitmapOf(v);
    if (b) {
      if (b.closed) throw new DOMException('An ImageBitmap is detached and could not be cloned.', 'DataCloneError');
      return {
        __csimType: 'ImageBitmap', width: b.width, height: b.height, colorSpace: b.colorSpace, tainted: b.tainted,
        pixels: b.pixels && byteView(b.pixels), pixelsP3: b.pixelsP3 && byteView(b.pixelsP3)
      };
    }
    const d = imageDataOf(v);
    if (d) return { __csimType: 'ImageData', width: d.width, height: d.height, colorSpace: d.colorSpace, pixelFormat: d.pixelFormat, data: byteView(d.data) };
    const c = offscreenOf(v);
    if (c) {
      if (!transferSet?.has(v)) throw new DOMException('An OffscreenCanvas could not be cloned because it was not transferred.', 'DataCloneError');
      return { __csimType: 'OffscreenCanvas', width: c.width, height: c.height };
    }
    return undefined;
  },
  fromRecord(r) {
    if (r.__csimType === 'ImageBitmap') {
      return bitmap.create(fromByteView(r.pixels), r.width, r.height, { colorSpace: r.colorSpace, tainted: r.tainted, pixelsP3: fromByteView(r.pixelsP3) });
    }
    if (r.__csimType === 'OffscreenCanvas') return new OffscreenCanvas(r.width, r.height);
    const type = pixelArray(r.pixelFormat);
    const imageData = Object.create(ImageData.prototype);
    const data = new type(r.data.buffer, r.data.byteOffset, r.data.byteLength / type.BYTES_PER_ELEMENT);
    initializeImageData(imageData, r.width, r.height, { colorSpace: r.colorSpace, pixelFormat: r.pixelFormat }, data);
    return imageData;
  },
  checkTransfer(t) {
    if (bitmapOf(t)?.closed) throw new DOMException('An ImageBitmap is detached and could not be transferred.', 'DataCloneError');
    if (offscreenOf(t)) checkOffscreenCanvasTransfer(t);
  },
  detach(t) {
    if (bitmapOf(t)) closeImageBitmap(t);
    else if (offscreenOf(t)) detachOffscreenCanvas(t);
  }
};

globalThis.ImageData                = ImageData;
globalThis.ImageBitmap              = ImageBitmap;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.OffscreenCanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;
globalThis.CanvasGradient           = gradient.interface;
globalThis.CanvasPattern            = pattern.interface;
globalThis.Path2D                   = Path2D;
globalThis.OffscreenCanvas          = OffscreenCanvas;
