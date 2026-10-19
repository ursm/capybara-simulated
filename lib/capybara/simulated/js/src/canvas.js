// The 2D canvas: an RGBA bitmap (`surfaceOf(canvas)._pixels`, a Uint8ClampedArray) and the CanvasRenderingContext2D,
// OffscreenCanvas, ImageData, ImageBitmap, CanvasGradient, CanvasPattern and Path2D surfaces over it. What a drawing
// operation does to the bitmap — its shape's coverage, its paint, the compositing operator, the clip, the shadow, the
// colour space — is native's (canvas.rs: `__dom.canvasDraw`), as are the paths it builds (canvas_path.rs) and the
// image file a bitmap is written as (image_encode.rs); this side keeps the drawing state, converts the arguments and
// hands each operation over. An image's bytes decode natively too (image_decode.rs), and a line of text is shaped and
// drawn to a coverage mask natively (text.rs).

import { latin1ToBytes }                                               from './bytes.js';
import { blobBytes, isBlob }                                           from './blob.js';
import { fontHandleFor }                                               from './font-metrics.js';
import { documentElementOf } from './document-tree.js';
import { isConnected } from './walk.js';
import {
  PLATFORM, brandKey, bufferSourceByteLength, bytesToBase64, constructedBy, interfaceCheck, isBufferOf, makeSlots, registerInterface, slotsOf
} from './webidl.js';
import {
  convertImageDataArguments, convertPath2DArguments, defineCanvasGradient, defineCanvasPattern, defineImageBitmap,
  installCanvasRenderingContext2D,
  convertOffscreenCanvasArguments, installImageData, installOffscreenCanvas, installOffscreenCanvasRenderingContext2D,
  installPath2D, toCanvasRenderingContext2DSettings
} from './generated/bindings.js';
import { EventTarget, installEventHandlerAttrs } from './events.js';
import { UNSIGNED, reflectNumber, setReflectedNumber } from './reflect.js';
import { imageRequestOf, isImageRequestElement } from './image-request.js';
import { videoTainted } from './media.js';

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
// An RGBA buffer converted IN PLACE from one colour space to another (`__dom.canvasConvert`) — a no-op where they match.
// Returns the buffer.
function convertColorSpace(data, from, to) {
  if (from !== to) globalThis.__dom.canvasConvert(data, from, to);
  return data;
}
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
// `request` is `src`'s image request, for a caller that has read it.
function resolveImagePixels(src, request = imageRequestOfSource(src)) {
  if (!src) return null;
  const b = bitmapOf(src);
  if (b) return b.pixels && b.width && b.height ? {pixels: b.pixels, width: b.width, height: b.height, pixelsP3: b.pixelsP3} : null;
  // An <img>'s bitmap is its intrinsic (natural) size — independent of any
  // width/height content attribute, which only affects layout. Other sources
  // (canvas / ImageBitmap) size their buffer by width/height directly.
  const surface = surfaceOf(src);
  if (surface._pixels) {
    const w = request ? request.width : src.width;
    const h = request ? request.height : src.height;
    if (w && h) return {pixels: surface._pixels, width: w, height: h, pixelsP3: src._pixelsP3 || null};
  }
  // HTMLVideoElement's first-decoded frame is cached the same shape.
  const f = src._csimVideoFrame;
  if (f && f._pixels && f.width && f.height) return {pixels: f._pixels, width: f.width, height: f.height, pixelsP3: null};
  return null;
}

// `src`'s image request, read once per draw (image-request.js) — null for a source that is not an image element.
const imageRequestOfSource = (src) => (src?._tag && isImageRequestElement(src) ? imageRequestOf(src) : null);

// Whether drawing / patterning from `src` taints the destination canvas (clears its origin-clean
// flag): a cross-origin image whose bytes aren't CORS-approved (its image request's taint, set by
// its load), an ImageBitmap carrying that taint, a <video> whose fetch was (an opaque SW response / a
// no-cors cross-origin network load — media.js `videoTainted`), or a
// <canvas>/OffscreenCanvas whose OWN context is already tainted (taint is transitive). A
// same-origin / CORS-approved / data: source is clean. `request` as resolveImagePixels's.
function imageSourceTainted(src, request = imageRequestOfSource(src)) {
  if (!src || typeof src !== 'object') return false;
  if (bitmapOf(src)?.tainted || videoTainted(src)) return true;    // ImageBitmap / <video>
  if (request?.tainted) return true;                               // <img> / SVG <image> / <input type=image>
  return canvasTainted(src);                                       // <canvas> / OffscreenCanvas
}

// Whether canvas `c`'s backing store is tainted — its origin-clean flag false (the engine's: canvas_state.rs). A
// canvas that never got a 2D context can't have been drawn to, so it's clean.
function canvasTainted(c) {
  const ctx = c && surfaceOf(c)._ctx;
  return !!ctx && !globalThis.__dom.canvasOriginClean(ctx._state);
}

// RGBA blit (`__dom.canvasBlit`): the `sw` × `sh` rectangle at (sx, sy) of `src` (`srcW` × `srcH`) copied over (dx,
// dy) of `dst` (`dstW` × `dstH`), scaled to `dw` × `dh` nearest-neighbour, what falls outside either left alone —
// what getImageData and putImageData move.
function blitRGBA(src, srcW, srcH, sx, sy, sw, sh, dst, dstW, dstH, dx, dy, dw, dh) {
  globalThis.__dom.canvasBlit(src, dst, new globalThis.Float64Array([srcW, srcH, sx, sy, sw, sh, dstW, dstH, dx, dy, dw, dh]));
}

// True when every argument is a finite number (the geometry / transform methods
// no-op on a non-finite coordinate per the canvas spec). `isFinite` reads only
// its first argument, so `every`'s (element, index, array) callback is safe here.
function allFinite(...xs) { return xs.every(isFinite); }

// The drawing-state attributes, by the code the engine names each with (canvas_state.rs): CanvasRenderingContext2D's in
// the order its IDL lists them — and those the context's own steps set or read.
const CONTEXT_ATTRIBUTES = [
  'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'strokeStyle', 'fillStyle',
  'shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor', 'filter', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
  'lineDashOffset', 'lang', 'font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'fontKerning',
  'fontStretch', 'fontVariantCaps', 'textRendering', 'wordSpacing'
];
const IMAGE_SMOOTHING = 2, STROKE_STYLE = 4, FILL_STYLE = 5, SHADOW_COLOR = 9, FONT = 17;
// …what `canvasStack` does to the state: save(), restore(), the state reset to its defaults.
const STATE_SAVE = 0, STATE_RESTORE = 1, STATE_RESET = 2;
// …what `canvasTransform` does to the CTM, or reads of it.
const CTM_TRANSLATE = 0, CTM_SCALE = 1, CTM_ROTATE = 2, CTM_TRANSFORM = 3, CTM_SET = 4, CTM_IDENTITY = 5, CTM_GET = 6;
// …the shape `canvasPathShape` makes of a path: its fill by the nonzero or the even-odd rule, its stroke, a focus ring's.
const SHAPE_FILL = 0, SHAPE_FILL_EVEN_ODD = 1, SHAPE_STROKE = 2, SHAPE_FOCUS_RING = 3;
// …the fill and stroke style, by the slot `canvasDraw` paints with one.
const PAINT_FILL = 0, PAINT_STROKE = 1;

// The 2D components [a,b,c,d,e,f] of a DOMMatrix2DInit (a DOMMatrix instance or a
// plain a–f / m11–m42 dict). Runs the spec DOMMatrix validation via DOMMatrix — a
// dict whose a and m11 (etc.) disagree is a TypeError. Values may be non-finite; the
// caller decides whether that's a no-op (setTransform) — hence the finite check here.
function matrix2DInit(t) {
  const m = globalThis.DOMMatrix.fromMatrix(t);
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

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
  // arises from an actual resize, which the engine refuses.
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

    // Crop, resize and flip the source's pixels — the engine's steps (canvas.rs `bitmapPixels`), into a fresh buffer,
    // null for one too large to hold, which browsers too report an InvalidStateError (their max-texture limit). With
    // none of them to do, the bitmap takes `px` itself when it is already private (`ownsBuffer`, a freshly decoded
    // Blob), else a copy: it never aliases live pixels.
    const finish = (px, w, h, ownsBuffer, colorSpace, p3Pixels) => {
      try {
        let out = px, ow = w, oh = h, transformed = false;
        if (cropForm || flipY || hasRW || hasRH) {
          const geometry = [w, h, +cropForm, csx, csy, csw, csh, hasRW ? rwU : NaN, hasRH ? rhU : NaN, +flipY];
          const r = globalThis.__dom.bitmapPixels(px, new globalThis.Float64Array(geometry));
          if (!r) return invalid();
          out = r.pixels; ow = r.width; oh = r.height;
          transformed = cropForm || flipY || ow !== w || oh !== h;
        } else if (!ownsBuffer) {
          out = new globalThis.Uint8ClampedArray(px);
        }
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
          pixelsP3: p3Pixels && !transformed && options.colorSpaceConversion !== 'none' ? p3Pixels : null
        }));
      } catch (_) {
        invalid();
      }
    };

    if (isBlob(source)) {
      const bytes = blobBytes(source);
      if (!bytes) return invalid();
      // A plain Blob (no crop) is shrunk as it decodes (`__dom.decodeImage`'s fit); the crop
      // form decodes at natural size and crops / resizes in `finish`.
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
      const request = imageRequestOfSource(source);
      const ip = resolveImagePixels(source, request);
      if (!ip || !ip.width || !ip.height) return invalid();
      const orientation = request ? request.orientation : 0;
      if (flipY && orientation > 1) return finish(...unturned(ip.pixels, ip.width, ip.height, orientation), true);
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

// CanvasGradient and CanvasPattern (HTML §4.12.5.1.8), generated from their IDL: opaque objects only a context makes,
// each holding its paint — the engine's (canvas_paint.rs): a gradient's kind, geometry and colour stops, a pattern's
// tile, the axes it repeats on, its colour space and its transform — and a pattern whether it is origin-clean.
const gradient = defineCanvasGradient({
  init(s, paint) { s.paint = paint; },
  // addColorStop(): an offset outside [0, 1] an IndexSizeError (a non-finite one the binding's TypeError), a colour
  // that does not parse a SyntaxError — the engine's to tell, and to keep the stops sorted.
  addColorStop(s, offset, color) {
    const refused = globalThis.__dom.canvasAddColorStop(s.paint, offset, color);
    if (refused === STOP_OFFSET_OUT_OF_RANGE) {
      throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (${offset}) is outside the range (0.0, 1.0).`, 'IndexSizeError');
    }
    if (refused === STOP_NO_COLOR) {
      throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('${color}') could not be parsed as a color.`, 'SyntaxError');
    }
  }
});
const GRADIENT = brandKey('CanvasGradient');
const gradientOf = (o) => slotsOf(o, GRADIENT);
// …why the engine refuses a stop (canvas_paint.rs `canvasAddColorStop`).
const STOP_OFFSET_OUT_OF_RANGE = 1, STOP_NO_COLOR = 2;
// …a gradient's kind, by the code the engine names it with.
const LINEAR_GRADIENT = 2, RADIAL_GRADIENT = 3, CONIC_GRADIENT = 4;

// The valid createPattern repetition keywords, in the order the engine names them.
const PATTERN_REPS = ['repeat', 'repeat-x', 'repeat-y', 'no-repeat'];

const pattern = defineCanvasPattern({
  init(s, paint, tainted) {
    s.paint = paint;
    s.tainted = tainted;   // built from a cross-origin source: it taints what it fills
  },
  // setTransform(): the pattern sampled in a space transformed by the matrix of the 2D dictionary (a DOMMatrix's members
  // or an a–f / m11–m42 one; an inconsistent one a TypeError) — one with a non-finite member leaving it as it was.
  setTransform(s, transform) {
    globalThis.__dom.canvasPatternTransform(s.paint, ...matrix2DInit(transform));
  }
});
const PATTERN = brandKey('CanvasPattern');
const patternOf = (o) => slotsOf(o, PATTERN);
// A gradient made, of `kind` and its geometry (`a` to `f`, as many as the kind has): its paint, and its interface
// object, which the paint traces back.
function newGradient(kind, a, b, c, d, e, f) {
  const paint = new globalThis.__dom.CanvasPaintBase();
  const made = gradient.create(paint);
  globalThis.__dom.canvasGradientInit(paint, made, kind, a, b, c, d, e, f);
  return made;
}
// …and a pattern, of a copy of its tile's `pixels` (`w` × `h`, Display P3 where `p3`).
function newPattern(pixels, w, h, repetition, p3, tainted) {
  const paint = new globalThis.__dom.CanvasPaintBase();
  const made = pattern.create(paint, tainted);
  globalThis.__dom.canvasPatternInit(paint, made, new globalThis.Uint8ClampedArray(pixels), w, h, PATTERN_REPS.indexOf(repetition), p3);
  return made;
}
// The paint of a fill or stroke style that is a gradient or a pattern, or undefined.
const paintOf = (v) => (gradientOf(v) ?? patternOf(v))?.paint;

// A path under construction — the context's current default path, and a Path2D's (the CanvasPath IDL mixin's steps):
// the arguments converted as WebIDL converts them, then handed to native (canvas_path.rs `Builder`), which keeps the
// path in `_buf` — its subpaths and current point, curves and arcs flattened on the way in — and writes it in place,
// handing back a bigger array where it outgrows this one. `state`, when given (the context's default path: its drawing
// state, canvas_state.rs), holds the CTM each point is baked through as it is added: a later transform does not move a
// point already in the path. A Path2D has none and keeps user-space points, which the consuming context's CTM maps when
// it paints.
const PATH_OP = {moveTo: 0, lineTo: 1, closePath: 2, rect: 3, roundRect: 4, bezierCurveTo: 5, quadraticCurveTo: 6,
                 arc: 7, ellipse: 8, arcTo: 9, reset: 10};

class PathBuilder {
  constructor(state) {
    this._state = state || null;
    this._buf = null;
    this.reset();
  }
  get _baked() { return this._state !== null; }
  get _empty() { return globalThis.__dom.canvasPathEmpty(this._buf); }
  _took(r) {
    if (Array.isArray(r)) throw r[0] === 'RangeError' ? new globalThis.RangeError(r[1]) : new globalThis.DOMException(r[1], r[0]);
    if (r) this._buf = r;
  }
  _op(op, a, b, c, d, e, f, g, h) {
    this._took(globalThis.__dom.canvasPath(this._buf, op, this._state, a, b, c, d, e, f, g, h));
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
    this._took(globalThis.__dom.canvasPath(this._buf, PATH_OP.roundRect, this._state, x, y, w, h, ...flat));
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
    // (…its drawing state the engine's: canvas_state.rs)
    this._state = new globalThis.__dom.CanvasStateBase();
    this._rectScratch = new PathBuilder();
    this._resetState();
    this.wrapper = new Interface(PLATFORM, this);   // the interface's object, which the page holds
    this._interface = Interface.name;
  }

  // Reset the rendering state to its defaults — at construction, `reset()`, and a resize (setting width / height resets
  // the context per spec): the drawing state and its stack, and the current path — not the bitmap's origin-clean flag
  // (canvas_state.rs), which nothing cleans.
  _resetState() {
    globalThis.__dom.canvasStack(this._state, STATE_RESET);
    this._pathObj = new PathBuilder(this._state);   // (…the default path, which bakes the CTM into each point)
  }

  // A drawing-state attribute (its code: `CONTEXT_ATTRIBUTES`), read and written as the engine has it — each setter
  // ignoring a value out of its range. A fill or stroke style that is a gradient or a pattern is that object; a colour
  // resolves `currentColor` to the canvas element's colour, asked only where the value names it; a `font` its relative
  // units against the bases they want, asked only where it may have one.
  _get(attribute) { return globalThis.__dom.canvasGet(this._state, attribute); }
  _set(attribute, value) {
    const state = this._state;
    if (attribute === FILL_STYLE || attribute === STROKE_STYLE || attribute === SHADOW_COLOR) {
      const paint = attribute !== SHADOW_COLOR ? paintOf(value) : undefined;
      if (paint !== undefined) {
        // (…a pattern that is not origin-clean taints the canvas as it is set: HTML's fillStyle / strokeStyle setters)
        if (patternOf(value)?.tainted) globalThis.__dom.canvasTaint(state);
        return globalThis.__dom.canvasSet(state, attribute, paint, true);
      }
      return globalThis.__dom.canvasSet(state, attribute, value, /currentcolor/i.test(value) ? this._currentColor() : 'black');
    }
    if (attribute === FONT) return globalThis.__dom.canvasSet(state, attribute, value, this._fontBases(value));
    globalThis.__dom.canvasSet(state, attribute, value);
  }

  // The CSS `currentColor` value: the canvas element's computed `color` (a detached
  // canvas / OffscreenCanvas has no element, so it falls back to the initial black).
  // Passed to the colour's parse so `currentColor` — top-level or nested in color-mix() /
  // a relative colour — resolves at assignment time.
  _currentColor() {
    try {
      const el = this.canvas;
      if (el && isConnected(el) && globalThis.__csimGetComputedStyle) {
        const col = globalThis.__csimGetComputedStyle(el).color;
        if (col) return col;
      }
    } catch (_) { /* fall through to the initial value */ }
    return 'black';
  }

  // (…their coordinates doubles, a non-finite one the binding's TypeError)
  createLinearGradient(x0, y0, x1, y1) {
    return newGradient(LINEAR_GRADIENT, x0, y0, x1, y1);
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (r0 < 0 || r1 < 0) throw new globalThis.DOMException('negative radius', 'IndexSizeError');
    return newGradient(RADIAL_GRADIENT, x0, y0, r0, x1, y1, r1);
  }
  createConicGradient(startAngle, x, y) {
    return newGradient(CONIC_GRADIENT, startAngle, x, y);
  }

  // createPattern(image, repetition): a tiled-image fill/stroke style. An empty repetition (null too, by the binding's
  // [LegacyNullToEmptyString]) is 'repeat'; any other non-keyword (including `undefined` → "undefined") is a
  // SyntaxError. Image usability (HTML "check the usability of the image argument") decides the rest: a still-loading /
  // srcless / zero-size <img> yields `null`; a BROKEN <img> (a request that failed) or a zero-area canvas throws
  // InvalidStateError.
  createPattern(image, repetition) {
    if (bitmapOf(image)?.closed) throw new DOMException(this._failure('createPattern') + 'The image source is detached.', 'InvalidStateError');
    if (repetition === '') repetition = 'repeat';
    if (!PATTERN_REPS.includes(repetition)) throw new globalThis.DOMException('bad repetition', 'SyntaxError');
    // A pattern built from a cross-origin (non-CORS-approved) source is itself tainted — painting
    // with it later taints whatever canvas it fills (pattern-from-{img,image,canvas}-cross-origin).
    const request = imageRequestOfSource(image);
    const tainted = imageSourceTainted(image, request);
    const src = resolveImagePixels(image, request);
    if (src) {
      // A wide-profile source used in a P3 context tiles from its preserved P3 rendering.
      const useP3 = this._attrs.colorSpace === 'display-p3' && src.pixelsP3;
      const px = useP3 ? src.pixelsP3 : src.pixels;
      const cs = useP3 ? 'display-p3' : sourceColorSpace(image);
      // Snapshot the source pixels — a later draw to a live source canvas must not
      // change the pattern.
      return newPattern(px, src.width, src.height, repetition, cs === 'display-p3', tainted);
    }
    if (isCanvasSource(image)) {
      const [w, h] = bitmapSize(image);
      if (!w || !h) throw new globalThis.DOMException('the canvas has zero size', 'InvalidStateError');
      const px = surfaceOf(image)._pixels || new globalThis.Uint8ClampedArray(w * h * 4);   // blank canvas → transparent tile
      return newPattern(px, w, h, repetition, sourceColorSpace(image) === 'display-p3', tainted);
    }
    // An <img>, SVG <image>, or <video> with no usable bitmap: per "check the usability
    // of the image argument", only a request that FAILED is "broken" (throw
    // InvalidStateError). A srcless / still-loading / zero-intrinsic-size image, or a
    // <video> with no decoded frame (readyState HAVE_NOTHING / HAVE_METADATA), is merely
    // "bad" usability → null. (<img> and SVG <image> share their current request's state, the engine's.)
    if (image._tag === 'img' || image._tag === 'image' || image._tag === 'video') {
      if (request?.broken) throw new globalThis.DOMException('the image is broken', 'InvalidStateError');
      return null;
    }
    // Anything else is not a CanvasImageSource (e.g. a string / plain object) — a
    // WebIDL type error, not a usability error.
    throw new globalThis.TypeError('createPattern: the image is not a usable image source');
  }

  // The drawing-state stack, the engine's: save() pushes a copy of the state — its transform, clip, styles and the rest —
  // and restore() pops it back (none: nothing). The current path is NOT part of it: it persists across them, per spec.
  save() { globalThis.__dom.canvasStack(this._state, STATE_SAVE); }
  restore() { globalThis.__dom.canvasStack(this._state, STATE_RESTORE); }
  // setLineDash(segments): ignored where a segment is negative or not finite, an odd list doubled — the engine's.
  setLineDash(segments) { globalThis.__dom.canvasLineDash(this._state, new globalThis.Float64Array(segments)); }
  getLineDash() { return globalThis.__dom.canvasLineDash(this._state); }

  // The current transformation matrix, the engine's to multiply: each transform method a no-op where an argument is not
  // finite (NaN / ±Infinity) — the matrix kept rather than poisoned. setTransform(transform) takes the matrix of a 2D
  // dictionary (the identity where none is given).
  translate(x, y) { globalThis.__dom.canvasTransform(this._state, CTM_TRANSLATE, x, y); }
  scale(x, y) { globalThis.__dom.canvasTransform(this._state, CTM_SCALE, x, y); }
  rotate(rad) { globalThis.__dom.canvasTransform(this._state, CTM_ROTATE, rad); }
  transform(a, b, c, d, e, f) { globalThis.__dom.canvasTransform(this._state, CTM_TRANSFORM, a, b, c, d, e, f); }
  setTransform(a, b, c, d, e, f) { globalThis.__dom.canvasTransform(this._state, CTM_SET, a, b, c, d, e, f); }
  setTransformMatrix(transform) { globalThis.__dom.canvasTransform(this._state, CTM_SET, ...matrix2DInit(transform)); }
  resetTransform() { globalThis.__dom.canvasTransform(this._state, CTM_IDENTITY); }
  // getTransform() — the current CTM as a fresh (2D) DOMMatrix.
  getTransform() {
    const m = this._ctm();
    return new globalThis.DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
  }
  _ctm() { return globalThis.__dom.canvasTransform(this._state, CTM_GET); }

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

  // ── Paths, as the rasterizer takes them ──
  // The shape a path (the current default path, or a Path2D) fills under the CTM, by the even-odd rule or nonzero, or its
  // stroke covers with the context's pen — its caps and joins, the dash pattern — or a focus ring's plain 2px line
  // (`__dom.canvasPathShape`).
  _fillShape(pathObj, evenOdd) {
    return globalThis.__dom.canvasPathShape(this._state, evenOdd ? SHAPE_FILL_EVEN_ODD : SHAPE_FILL, pathObj._buf, pathObj._baked);
  }
  _strokeShape(pathObj, how = SHAPE_STROKE) {
    return globalThis.__dom.canvasPathShape(this._state, how, pathObj._buf, pathObj._baked);
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

  // ── Drawing: one operation, handed to the rasterizer ──
  // Draw `shape` (`_fillShape`, `_strokeShape`, `_rectShape`, or a glyph `mask`'s) with `paint` (the fill or stroke
  // style by its slot — `PAINT_FILL`, `PAINT_STROKE` — whatever it is, or `{data, pixels}` — an image's, clearRect's,
  // a focus ring's) into the bitmap (`__dom.canvasDraw`): under the state's clip, operator, `globalAlpha` and shadow —
  // or, `plain`, opaque and source-over with none, as a focus ring is drawn.
  _draw(shape, paint, plain = false, mask = null) {
    const buf = this._buffer();
    if (!buf) return;
    const [w, h] = bitmapSize(this.canvas);
    const solid = typeof paint === 'number';
    globalThis.__dom.canvasDraw(this._state, buf, w, h, this._attrs.colorSpace === 'display-p3', plain, shape, mask,
                                solid ? paint : paint.data, solid ? null : paint.pixels || null);
  }
  // A user-space rectangle's shape: its device box where the CTM keeps it axis-aligned (no rotation or shear), its
  // corners' ring otherwise.
  _rectShape(x, y, w, h) {
    const m = this._ctm();
    if (m[1] === 0 && m[2] === 0) {
      return new globalThis.Float64Array([0, m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5]]);
    }
    return this._fillShape(this._rectPath(x, y, w, h), false);
  }

  // The draw-path operations take the path given — a Path2D's PathBuilder — or null for the current default path.
  //
  // fill([path,] fillRule): rasterize the path, subpaths implicitly closed, under the winding rule.
  fill(path, fillRule) {
    path ??= this._pathObj;
    if (!path._empty) this._draw(this._fillShape(path, fillRule === 'evenodd'), PAINT_FILL);
  }

  // stroke([path]): the path thickened by the pen (lineWidth, lineCap / lineJoin, the dash pattern) and painted in one
  // nonzero pass — the union covers overlaps exactly once, so a translucent strokeStyle doesn't darken at corners.
  stroke(path) {
    path ??= this._pathObj;
    if (!path._empty) this._draw(this._strokeShape(path), PAINT_STROKE);
  }

  // clip([path,] fillRule): intersect the clip region with the path, so subsequent draws are masked
  // (`__dom.canvasClip` fills the mask, the state's from then on: a pixel is inside where it is at least half covered).
  // Part of the drawing state (save/restore'd); clip() only ever shrinks the region.
  clip(path, fillRule) {
    path ??= this._pathObj;
    const [cw, ch] = bitmapSize(this.canvas);
    if (!cw || !ch) return;
    const mask = new globalThis.Uint8Array(cw * ch);   // (…a canvas too large for one is a RangeError here)
    globalThis.__dom.canvasClip(this._state, mask, cw, ch, this._fillShape(path, fillRule === 'evenodd'));
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
    return globalThis.__dom.canvasHit(this._strokeShape(path ?? this._pathObj), x, y);
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
    const doc = this.canvas._ownerDocument;
    if (!doc || doc._activeElement !== element) return;
    if (typeof this.canvas._contains !== 'function' || !this.canvas._contains(element)) return;
    // A focus ring is a UA decoration, not an author stroke: a plain solid outline, the author's dash pattern and
    // cap / join ignored (`SHAPE_FOCUS_RING`), painted opaque and source-over, globalAlpha / globalCompositeOperation /
    // shadow ignored — which would otherwise dash it, fade it, shadow it, or (under a whole-canvas operator like 'copy')
    // erase the rest of the canvas. The clip still applies.
    if (!path._empty) this._draw(this._strokeShape(path, SHAPE_FOCUS_RING), { data: new globalThis.Float64Array([0, 0, 0, 0, 1]) }, true);
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
      if (isConnected(el)) fs = parseFloat(cs.fontSize) || defaultFs;
      lh = parseFloat(cs.lineHeight);   // (…px, or `normal`)
    } catch (_) { /* fall through */ }
    return {fs, lh: lh > 0 ? lh : fs * 1.2};
  }
  // …the root's, for `rem` / `rlh`.
  _rootBase() {
    const doc = this.canvas && this.canvas._ownerDocument;
    return this._fontBase(doc && documentElementOf(doc), 16);
  }
  // The bases a `font` value's relative units resolve against (`__dom.canvasSet`'s FONT): its size in px, `em` / `%`
  // of the canvas element's font size, `rem` of the root's, `lh` / `rlh` of their line heights — asked only where a
  // relative unit can want them, as each is a style read.
  _fontBases(input) {
    if (!/em|%|lh/i.test(input)) return undefined;
    const own = this._fontBase(this.canvas, 10), root = this._rootBase();
    return new globalThis.Float64Array([own ? own.fs : 10, root ? root.fs : 16, own ? own.lh : NaN, root ? root.lh : NaN]);
  }

  // What a text op is answered with (`__dom.canvasFontFace` says which it wants): the face the font's family stack
  // resolves to in the bucket its weight and style fall in — as a page's text does (font-metrics.js: its `@font-face`
  // where the document declares one, else the system face fontconfig gives it) — its native handle (font.rs), which
  // the engine shapes and draws the line with; the canvas element's direction, where the
  // state's inherits it; the root's font size, where a spacing is in `rem` — `[face, inheritedRtl, rootFontSize]`.
  _textInputs() {
    const [bucket, family, inherits, rem] = globalThis.__dom.canvasFontFace(this._state);
    return [fontHandleFor(family, bucket), inherits && this._inheritedRtl(), rem ? this._rootFontSize() : 16];
  }
  // The canvas element's direction — memoized per tree generation AND cascade version (getComputedStyle(canvas).direction
  // is cascade-derived, and a deferred stylesheet / @media change rebuilds the cascade without a DOM mutation) so a
  // steady draw loop does not re-run the cascade.
  _inheritedRtl() {
    const gen = globalThis.__csimTreeGen ? globalThis.__csimTreeGen() : 0;
    const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
    if (this._inheritDirGen === gen && this._inheritDirCV === cv) return this._inheritDir;
    let rtl = false;
    try {
      const el = this.canvas;
      if (el && el._nodeType === 1 && globalThis.__csimGetComputedStyle) rtl = globalThis.__csimGetComputedStyle(el).direction === 'rtl';
    } catch (_) { /* offscreen / detached → ltr */ }
    this._inheritDirGen = gen; this._inheritDirCV = cv; this._inheritDir = rtl;
    return rtl;
  }
  // …and the root's font size.
  _rootFontSize() {
    const root = this._rootBase();
    return root ? root.fs : 16;
  }

  // measureText(text): the line's metrics, its advance widened by its spacing, its bounding box from the anchor
  // `textAlign` puts it at — the engine's (canvas_text.rs `canvasMeasureText`).
  measureText(text) {
    const m = globalThis.__dom.canvasMeasureText(this._state, text, ...this._textInputs());
    return {
      width: m[0],
      actualBoundingBoxLeft: m[1],
      actualBoundingBoxRight: m[2],
      actualBoundingBoxAscent: m[3],
      actualBoundingBoxDescent: m[4],
      fontBoundingBoxAscent: m[5],
      fontBoundingBoxDescent: m[6],
      emHeightAscent: m[7],
      emHeightDescent: m[8],
      hangingBaseline: m[9],
      alphabeticBaseline: m[10],
      ideographicBaseline: m[11]
    };
  }

  // fillText / strokeText: the line drawn at (x, y) with the fill or the stroke style, condensed to `maxWidth` — the
  // engine's (canvas_text.rs `canvasDrawText`). strokeText is approximated as a filled glyph (glyph-outline stroking
  // isn't modeled) — the common use is a visible label; the fill/stroke colour differs.
  fillText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, PAINT_FILL); }
  strokeText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, PAINT_STROKE); }
  _drawText(text, x, y, maxWidth, slot) {
    const buf = this._buffer();
    if (!buf) return;
    const [w, h] = bitmapSize(this.canvas);
    globalThis.__dom.canvasDrawText(this._state, buf, w, h, this._attrs.colorSpace === 'display-p3', text, x, y, maxWidth,
                                    slot, null, ...this._textInputs());
  }

  fillRect(x, y, w, h) {
    if (!allFinite(x, y, w, h) || !w || !h) return;
    this._draw(this._rectShape(x, y, w, h), PAINT_FILL);
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
    this._draw(this._strokeShape(this._rectPath(x, y, w, h)), PAINT_STROKE);
  }

  // drawImage(): `source` a CanvasImageSource (the binding's union), drawn from its rectangle (sx, sy, sw, sh) to
  // (dx, dy, dw, dh) — the sizes it does not give its own.
  drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (bitmapOf(source)?.closed) throw new DOMException(this._failure('drawImage') + 'The image source is detached.', 'InvalidStateError');
    const request = imageRequestOfSource(source);
    let src = resolveImagePixels(source, request);
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
    if (imageSourceTainted(source, request)) globalThis.__dom.canvasTaint(this._state);
    // A wide-profile (Adobe/CMYK) source carries a separate Display-P3 rendering — use it (not the clipped sRGB one)
    // when drawing into a P3 canvas, so its wide colours survive. The rasterizer brings the source into this canvas's
    // colour space (on its own copy, which also keeps a canvas drawn onto itself reading its pixels from before).
    let srcCS = sourceColorSpace(source);
    if (this._attrs.colorSpace === 'display-p3' && src.pixelsP3) {
      src = { pixels: src.pixelsP3, width: src.width, height: src.height };
      srcCS = 'display-p3';
    }
    const iw = src.width, ih = src.height;
    // (…the source rectangle in image pixels, the whole bitmap by default; the destination's default the image's NATURAL
    // size — an image element's bitmap over its source's pixel density, a `2x` candidate's half: HTML, "one CSS pixel in
    // the image treated as one unit"; Chrome and Firefox)
    const nw = request && request.naturalWidth > 0 ? request.naturalWidth : iw;
    const nh = request && request.naturalHeight > 0 ? request.naturalHeight : ih;
    sw ??= iw; sh ??= ih; dw ??= nw; dh ??= nh;
    if (!allFinite(sx, sy, sw, sh, dx, dy, dw, dh)) return;   // a non-finite argument is a no-op
    if (sw === 0 || sh === 0) return;                         // a zero-size source rect draws nothing
    // Drawn like any other shape — the destination rectangle through the CTM — under the clip, globalAlpha, the
    // operator and the shadow, each covered pixel sampling the source (nearest, or bilinear where smoothing is on and
    // the image is scaled or rotated; a negative dw / dh mirrors).
    this._draw(this._fillShape(this._rectPath(dx, dy, dw, dh), false), {
      data: new globalThis.Float64Array([6, iw, ih, +(srcCS === 'display-p3'), sx, sy, sw, sh, dx, dy, dw, dh, +this._get(IMAGE_SMOOTHING)]),
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
    if (!globalThis.__dom.canvasOriginClean(this._state)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
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
  CONTEXT_ATTRIBUTES.forEach((name, attribute) => {
    impl[`get_${name}`] = (c) => engineOf(c)._get(attribute);
    impl[`set_${name}`] = (c, v) => { engineOf(c)._set(attribute, v); };
  });
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
  return file ? 'data:' + file[0] + ';base64,' + bytesToBase64(file[1]) : 'data:,';
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
