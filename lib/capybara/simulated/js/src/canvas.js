// The 2D canvas: an RGBA bitmap (`canvas._pixels`, the page's own Uint8ClampedArray) and the CanvasRenderingContext2D,
// OffscreenCanvas, ImageData, ImageBitmap, CanvasGradient, CanvasPattern and Path2D surfaces over it. What a drawing
// operation does to the bitmap — its shape's coverage, its paint, the compositing operator, the clip, the shadow, the
// colour space — is native's (canvas.rs: `__dom.canvasDraw`); this side keeps the drawing state, validates the
// arguments, builds paths, and hands each operation over. Images decode through the host (`__csim_decodeImage`,
// libvips), text renders to a coverage mask there (`__csim_renderText`, pango).

import { fetchTransfer, stashTransfer, latin1ToBytes }                 from './bytes.js';
import { blobBytes }                                                   from './blob.js';
import { CSS_LENGTH_RE, serializeAlpha } from './css-utils.js';
import { resolveFontFace }                                             from './font-metrics.js';

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
// `head` and then `spec`, one Float64Array.
function prefixed(head, spec) {
  const out = new globalThis.Float64Array(head.length + spec.length);
  out.set(head); out.set(spec, head.length);
  return out;
}

// CSS generic font families → pango's generic aliases (fontconfig resolves the
// rest by name). Unlisted families pass through verbatim.
const PANGO_GENERIC = {
  'sans-serif': 'Sans', 'serif': 'Serif', 'monospace': 'Monospace',
  'system-ui': 'Sans', 'ui-sans-serif': 'Sans', 'ui-serif': 'Serif',
  'ui-monospace': 'Monospace', 'cursive': 'Sans', 'fantasy': 'Sans', '': 'Sans',
};


// measureText cache keyed by "pangoFont\0text" — the metrics depend only on the
// font and string, not the context state, so it is shared across contexts.
const measureCache = new globalThis.Map();

// Plain-value drawing-state fields snapshotted by save() / restore() (the object-
// valued ones — transform, styles, clip, dash — are handled explicitly).
const STATE_KEYS = [
  'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality',
  'font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing',
  'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'lang', 'filter',
  'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
];

// Enum keyword sets for the text drawing-state IDL attributes. A setter ignores any
// value not in its set (keeps the previous), per spec — no case-folding or trimming, so
// 'END', 'end ' and 'end\0' are all invalid.
const TEXT_ALIGNS     = new Set(['start', 'end', 'left', 'right', 'center']);
const TEXT_BASELINES  = new Set(['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']);
const TEXT_DIRECTIONS = new Set(['ltr', 'rtl', 'inherit']);
// The canvas text-preparation algorithm replaces every tab / line-feed / form-feed /
// carriage-return with a space (canvas text is a single line — a raw LF would make
// pango wrap and wreck the metrics), before spacing and rendering.
const CANVAS_TEXT_WS = /[\t\n\f\r]/g;
const FONT_VARIANT_CAPS = new Set(['normal', 'small-caps', 'all-small-caps', 'petite-caps',
  'all-petite-caps', 'unicase', 'titling-caps']);
const TEXT_RENDERINGS   = new Set(['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision']);
const FONT_KERNINGS     = new Set(['auto', 'normal', 'none']);

// letterSpacing / wordSpacing take a CSS <length>: a number with a length unit (or a
// bare 0). A bad unit ('0s', '1deg'), a keyword ('normal', 'initial') or a non-finite
// number all fail to parse and are ignored. Returns the normalised length or null.
function parseCssLength(v) {
  v = String(v).trim();
  if (CSS_LENGTH_RE.test(v)) return v.toLowerCase();   // normalize the unit case ('1PX' → '1px')
  // A unitless number is a valid <length> only when it is zero (any spelling: 0, +0, 0.0).
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) && Number(v) === 0 ? '0px' : null;
}

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

// Invert a 2D affine matrix `[a, b, c, d, e, f]`, or null when singular — how a closed subpath's first point, stored
// transformed, is taken back to the user space the next segment is built in.
function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !isFinite(det)) return null;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id,
          (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

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
// source to an RGBA buffer (decoding a Blob via libvips, snapshotting a canvas / image /
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
  return new Promise((resolve, reject) => {
    const invalid = () => reject(new globalThis.DOMException('the image argument is not usable', 'InvalidStateError'));
    const typeErr = () => reject(new globalThis.TypeError('createImageBitmap: unsupported image source'));

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
        // `imageOrientation: 'flipY'` mirrors the bitmap top-to-bottom. 'from-image'
        // (the default) / 'none' keep the decoded orientation — we don't model EXIF
        // orientation, so those are a no-op.
        if (options.imageOrientation === 'flipY') {
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
      // A plain Blob (no crop) still uses libvips' cheap downscale for resize; the crop
      // form decodes at natural size and crops/resizes via blitRGBA.
      const decoded = globalThis.__csim_decodeImage(
        latin1ToBytes(bytes), cropForm ? 0 : (hasRW ? rwU : 0), cropForm ? 0 : (hasRH ? rhU : 0));
      if (!decoded) return invalid();
      const pixelBytes = fetchTransfer(decoded.refId);
      if (!pixelBytes) return invalid();
      const px = new globalThis.Uint8ClampedArray(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
      const blobCS = decoded.colorSpace || 'srgb';
      let p3 = null;
      if (decoded.refIdP3) { const pb = fetchTransfer(decoded.refIdP3); if (pb) p3 = new globalThis.Uint8ClampedArray(pb.buffer, pb.byteOffset, pb.byteLength); }
      // The decoded buffer is private (and vips already resized a non-crop Blob, so
      // finish()'s resize is a no-op there — dims match).
      return finish(px, decoded.width | 0, decoded.height | 0, true, blobCS, p3);
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
      return finish(ip.pixels, ip.width, ip.height, false, undefined, source._pixelsP3);
    }
    return typeErr();
  });
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

// The path-building surface (the CanvasPath IDL mixin) shared by the context's current default path and by Path2D: a
// list of subpaths, each `{pts, closed}` with its points flat (`[x, y, x, y, …]`). Curves and arcs are flattened on the
// way in (`__dom.canvasCurve`) at a resolution from `_scale()` — the owning context's CTM scale, or 1 for a standalone
// Path2D. What a path covers, filled or stroked, is native's (canvas_path.rs), handed the points by `_pathSpec`.
export class CanvasPath {
  // `transformFn`, when given (the context's current default path), returns the CTM
  // to bake into each point AS IT IS ADDED — the spec transforms path points by the
  // current transform at add-time, so a later transform change doesn't move points
  // already in the path. A standalone Path2D passes none and stores raw coordinates
  // (the consuming context applies its CTM at fill/stroke time).
  constructor(scaleFn, transformFn) {
    this._scaleFn = scaleFn || (() => 1);
    this._transformFn = transformFn || null;
    this.reset();
  }
  reset() {
    this._path = []; this._sub = null; this._hasPoint = false;
    this._cx = this._cy = this._sx = this._sy = 0;
  }
  _scale() { return this._scaleFn() || 1; }
  get _baked() { return this._transformFn != null; }

  // Add a user-space point to `pts` in its STORED form: the add-time-CTM-baked device point for a context's default
  // path, or the raw point for a Path2D. The current point (`_cx`/`_cy`/`_sx`/`_sy`) stays in USER space for the
  // curve/arc math; only the stored points are baked.
  _store(pts, x, y) {
    if (this._transformFn) {
      const m = this._transformFn();
      pts.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    } else {
      pts.push(x, y);
    }
  }
  // …and a run of them, flat.
  _storeAll(pts, flat) {
    for (let k = 0; k + 1 < flat.length; k += 2) this._store(pts, flat[k], flat[k + 1]);
  }

  // Start a new subpath at (x, y) and make it the current point.
  _moveToPoint(x, y) {
    this._sub = {pts: [], closed: false};
    this._store(this._sub.pts, x, y);
    this._path.push(this._sub);
    this._cx = this._sx = x; this._cy = this._sy = y;
    this._hasPoint = true;
  }

  // The spec's "ensure there is a subpath for (x, y)": when there is no current
  // point, seed one at (x, y) (the first control point for the curve methods).
  _ensurePoint(x, y) { if (!this._hasPoint) this._moveToPoint(x, y); }

  // The path-building methods carry their own WebIDL arity check so a DIRECT Path2D
  // call (which doesn't go through the context's delegators) also throws on too few
  // arguments; the context delegators pass fixed positional args, so they validate
  // the caller's count themselves before delegating.
  moveTo(x, y) { argc(arguments.length, 2); if (allFinite(x = +x, y = +y)) this._moveToPoint(x, y); }

  lineTo(x, y) {
    argc(arguments.length, 2);
    if (!allFinite(x = +x, y = +y)) return;
    if (!this._hasPoint) { this._moveToPoint(x, y); return; }   // first lineTo acts as moveTo
    this._store(this._sub.pts, x, y); this._cx = x; this._cy = y;
  }

  closePath() {
    if (!this._sub || this._sub.pts.length === 0) return;
    this._sub.closed = true;
    // The new subpath begins at the SAME (already-stored) first point of the closed
    // subpath — reuse it rather than re-baking `_sx/_sy` with the current transform,
    // which would misplace it if the CTM changed since this subpath's moveTo.
    const fx = this._sub.pts[0], fy = this._sub.pts[1];
    this._sub = {pts: [fx, fy], closed: false};
    this._path.push(this._sub);
    this._hasPoint = true;
    // Express that point in USER space for the curve/arc math (inverse of the add-
    // time transform for a baked default path; the raw point itself for a Path2D).
    let ux = fx, uy = fy;
    if (this._transformFn) {
      const inv = invertMatrix(this._transformFn());
      if (inv) { ux = inv[0] * fx + inv[2] * fy + inv[4]; uy = inv[1] * fx + inv[3] * fy + inv[5]; }
    }
    this._cx = this._sx = ux; this._cy = this._sy = uy;
  }

  rect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    const pts = [];
    this._storeAll(pts, [x, y, x + w, y, x + w, y + h, x, y + h]);
    this._path.push({pts, closed: true});
    this._moveToPoint(x, y);   // rect() leaves a fresh subpath at (x, y)
  }

  // roundRect(x, y, w, h, radii): a rectangle with rounded corners. `radii` is a
  // number, an {x,y} radius, or a 1–4 list of those (CSS corner order:
  // top-left, top-right, bottom-right, bottom-left, with the usual 1/2/3-value
  // shorthands). Radii are clamped so opposite corners don't overlap.
  roundRect(x, y, w, h, radii = 0) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    const list = Array.isArray(radii) ? radii : [radii];
    if (list.length < 1 || list.length > 4) throw new globalThis.RangeError('roundRect: 1–4 radii');
    let nonFinite = false;
    const norm = v => {
      const rx = v && typeof v === 'object' ? +v.x : +v;
      const ry = v && typeof v === 'object' ? +v.y : +v;
      // A non-finite radius (including -Infinity) makes the whole call a no-op — the
      // non-finite check comes BEFORE the negative check, so only a FINITE negative
      // radius is a RangeError.
      if (!isFinite(rx) || !isFinite(ry)) { nonFinite = true; return [rx, ry]; }
      if (rx < 0 || ry < 0) throw new globalThis.RangeError('roundRect: negative radius');
      return [rx, ry];
    };
    const c = list.map(norm);
    if (nonFinite) return;   // a non-finite radius makes the whole call a no-op (spec)
    // [top-left, top-right, bottom-right, bottom-left]
    const [tl, tr, br, bl] = c.length === 1 ? [c[0], c[0], c[0], c[0]]
                           : c.length === 2 ? [c[0], c[1], c[0], c[1]]
                           : c.length === 3 ? [c[0], c[1], c[2], c[1]]
                           : c;
    // Negative width/height flips which corners are which; normalize the box and
    // swap radii to match, so the rounding follows the visual rectangle. An odd number
    // of sign flips also REVERSES the traversal winding (the shape is the same, but a
    // negative-dimension rect winds the opposite way — so overlapping ones cancel under
    // the nonzero rule); the reversal is applied to the built subpath below.
    const flip = (w < 0) !== (h < 0);
    let corners = [tl, tr, br, bl];
    if (w < 0) { x += w; w = -w; corners = [corners[1], corners[0], corners[3], corners[2]]; }
    if (h < 0) { y += h; h = -h; corners = [corners[3], corners[2], corners[1], corners[0]]; }
    // Clamp radii to fit: scale down by the tightest shared-edge ratio. An edge
    // with zero total radius imposes no constraint (ratio → Infinity); a zero-
    // length edge forces the radii to collapse (ratio → 0).
    const ratio = (num, den) => den > 0 ? num / den : Infinity;
    const k = Math.min(1, ratio(w, corners[0][0] + corners[1][0]), ratio(w, corners[3][0] + corners[2][0]),
                       ratio(h, corners[0][1] + corners[3][1]), ratio(h, corners[1][1] + corners[2][1]));
    const [rtl, rtr, rbr, rbl] = corners.map(([rx, ry]) => [rx * k, ry * k]);
    this.moveTo(x + rtl[0], y);
    this.lineTo(x + w - rtr[0], y);
    this.ellipse(x + w - rtr[0], y + rtr[1], rtr[0], rtr[1], 0, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - rbr[1]);
    this.ellipse(x + w - rbr[0], y + h - rbr[1], rbr[0], rbr[1], 0, 0, Math.PI / 2);
    this.lineTo(x + rbl[0], y + h);
    this.ellipse(x + rbl[0], y + h - rbl[1], rbl[0], rbl[1], 0, Math.PI / 2, Math.PI);
    this.lineTo(x, y + rtl[1]);
    this.ellipse(x + rtl[0], y + rtl[1], rtl[0], rtl[1], 0, Math.PI, Math.PI * 1.5);
    const sub = this._sub;               // the just-built rect subpath (closePath spawns a new one)
    this.closePath();
    if (flip) {                          // reverse the winding for a net-negative-dimension rect
      const pts = sub.pts, rev = [];
      for (let k = pts.length - 2; k >= 0; k -= 2) rev.push(pts[k], pts[k + 1]);
      sub.pts = rev;
    }
    this._moveToPoint(x, y);   // like rect(), leave a fresh subpath at (x, y)
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    argc(arguments.length, 6);
    if (!allFinite(c1x = +c1x, c1y = +c1y, c2x = +c2x, c2y = +c2y, x = +x, y = +y)) return;
    this._ensurePoint(c1x, c1y);   // spec: seed a subpath at the first control point
    this._storeAll(this._sub.pts, globalThis.__dom.canvasCurve(0, this._scale(), this._cx, this._cy, c1x, c1y, c2x, c2y, x, y));
    this._cx = x; this._cy = y;
  }

  quadraticCurveTo(cx, cy, x, y) {
    argc(arguments.length, 4);
    if (!allFinite(cx = +cx, cy = +cy, x = +x, y = +y)) return;
    this._ensurePoint(cx, cy);     // spec: seed a subpath at the control point
    this._storeAll(this._sub.pts, globalThis.__dom.canvasCurve(1, this._scale(), this._cx, this._cy, cx, cy, x, y));
    this._cx = x; this._cy = y;
  }

  arc(cx, cy, r, a0, a1, ccw) {
    // A non-finite argument is a silent no-op; a (finite) negative radius throws.
    argc(arguments.length, 5);
    if (!allFinite(cx = +cx, cy = +cy, r = +r, a0 = +a0, a1 = +a1)) return;
    if (r < 0) throw new globalThis.DOMException('arc: the radius is negative', 'IndexSizeError');
    this._arcImpl(cx, cy, r, r, 0, a0, a1, !!ccw);
  }

  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
    argc(arguments.length, 7);
    if (!allFinite(cx = +cx, cy = +cy, rx = +rx, ry = +ry, rot = +rot, a0 = +a0, a1 = +a1)) return;
    if (rx < 0 || ry < 0) throw new globalThis.DOMException('ellipse: a radius is negative', 'IndexSizeError');
    this._arcImpl(cx, cy, rx, ry, rot, a0, a1, !!ccw);
  }

  // An (optionally rotated) elliptical arc, flattened (`__dom.canvasCurve`), appended to the current subpath — the edge
  // from the current point to the arc's start made by its first point, or the subpath started there when there is none.
  _arcImpl(cx, cy, rx, ry, rot, a0, a1, ccw) {
    const pts = globalThis.__dom.canvasCurve(2, this._scale(), cx, cy, rx, ry, rot, a0, a1, +ccw);
    if (!this._hasPoint) this._moveToPoint(pts[0], pts[1]);
    this._storeAll(this._sub.pts, pts);
    this._cx = pts[pts.length - 2]; this._cy = pts[pts.length - 1]; this._hasPoint = true;
  }

  arcTo(x1, y1, x2, y2, r) {
    argc(arguments.length, 5);
    if (!allFinite(x1 = +x1, y1 = +y1, x2 = +x2, y2 = +y2, r = +r)) return;
    if (r < 0) throw new globalThis.DOMException('arcTo: the radius is negative', 'IndexSizeError');
    this._ensurePoint(x1, y1);   // spec: seed a subpath at (x1, y1) when the path is empty
    // The tangent points on the two edges and the arc between them (`__dom.canvasArcTo`) — or a straight line to the
    // corner where there is no arc to draw.
    const c = globalThis.__dom.canvasArcTo(this._cx, this._cy, x1, y1, x2, y2, r);
    if (!c.length) { this.lineTo(x1, y1); return; }
    this.lineTo(c[0], c[1]);
    this._arcImpl(c[2], c[3], r, r, 0, c[4], c[5], !!c[6]);
    this._cx = c[7]; this._cy = c[8];
  }
}

// A standalone path usable with fill(path) / stroke(path) / clip(path) /
// isPointInPath(path, …). Built from the CanvasPath methods, copied from another
// Path2D, or parsed from an SVG path-data string. Flattened at scale 1 (the
// context re-flattens nothing; the pre-built points are transformed at paint).
export class Path2D extends CanvasPath {
  constructor(arg) {
    super();
    if (arg instanceof CanvasPath) this._copyFrom(arg);
    else if (typeof arg === 'string') parseSvgPath(this, arg);
  }
  get [Symbol.toStringTag]() { return 'Path2D'; }

  // Append another path's subpaths, optionally through a DOMMatrix2DInit transform
  // (both the a–f and m11–m42 alias forms).
  addPath(path, transform) {
    if (!(path instanceof CanvasPath)) return;
    const m = transform ? matrix2DInit(transform) : null;
    if (m && !m.every(isFinite)) return;   // a non-finite transform adds nothing
    // Snapshot first: adding a path to itself must not iterate the array we push into.
    for (const sub of path._path.slice()) {
      const pts = sub.pts.slice();
      if (m) {
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const x = pts[k], y = pts[k + 1];
          pts[k] = m[0] * x + m[2] * y + m[4]; pts[k + 1] = m[1] * x + m[3] * y + m[5];
        }
      }
      this._path.push({pts, closed: sub.closed});
    }
  }

  _copyFrom(path) {
    for (const sub of path._path) this._path.push({pts: sub.pts.slice(), closed: sub.closed});
    this._cx = path._cx; this._cy = path._cy; this._sx = path._sx; this._sy = path._sy; this._hasPoint = path._hasPoint;
  }
}

// Build `target` from SVG path data: the calls it makes (`__dom.canvasSvgPath` — absolute and relative commands,
// smooth curves, arcs in endpoint form), replayed through the path's own methods.
function parseSvgPath(target, d) {
  const c = globalThis.__dom.canvasSvgPath(String(d));
  for (let k = 0; k < c.length;) {
    switch (c[k]) {
      case 0: target.moveTo(c[k + 1], c[k + 2]); k += 3; break;
      case 1: target.lineTo(c[k + 1], c[k + 2]); k += 3; break;
      case 2: target.bezierCurveTo(c[k + 1], c[k + 2], c[k + 3], c[k + 4], c[k + 5], c[k + 6]); k += 7; break;
      case 3: target.quadraticCurveTo(c[k + 1], c[k + 2], c[k + 3], c[k + 4]); k += 5; break;
      case 4: target.ellipse(c[k + 1], c[k + 2], c[k + 3], c[k + 4], c[k + 5], c[k + 6], c[k + 7], !!c[k + 8]); k += 9; break;
      default: target.closePath(); k += 1;
    }
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
    this._pathObj                 = new CanvasPath(() => this._ctmScale(), () => this._m);   // default path bakes the CTM per point
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
  set textBaseline(v) { if (TEXT_BASELINES.has(v)) this._textBaseline = v; }
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
  get letterSpacing()  { return this._letterSpacing; }
  set letterSpacing(v) { const p = parseCssLength(v); if (p !== null) this._letterSpacing = p; }
  get wordSpacing()  { return this._wordSpacing; }
  set wordSpacing(v) { const p = parseCssLength(v); if (p !== null) this._wordSpacing = p; }
  // font: on getting, the canonical serialized shorthand; on setting, parse-and-ignore
  // an unparsable value (keep the previous), resolving the size to px at assignment.
  get font()  { return this._font || '10px sans-serif'; }
  set font(v) { const s = this._serializeFont(v); if (s !== null) this._font = s; }

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

  // Average scale of the CTM, used to pick a curve/arc flattening resolution that
  // stays smooth in device pixels regardless of the transform (the CanvasPath's
  // scale provider).
  _ctmScale() {
    const m = this._m;
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) || 1;
  }

  // ── Paths, as the rasterizer takes them ──
  // A path (the current default path, or a Path2D) with the CTM: `[…ctm, baked, …subpaths]`, each subpath `[closed,
  // count, x, y, …]` (canvas_path.rs `Path`).
  _pathSpec(pathObj) {
    let n = 7;
    for (const sub of pathObj._path) n += 2 + sub.pts.length;
    const out = new globalThis.Float64Array(n), m = this._m;
    out.set(m); out[6] = +pathObj._baked;
    let k = 7;
    for (const sub of pathObj._path) {
      out[k++] = +sub.closed; out[k++] = sub.pts.length / 2;
      out.set(sub.pts, k); k += sub.pts.length;
    }
    return out;
  }
  // The shape a path fills, under the even-odd rule or nonzero.
  _fillShape(pathObj, evenOdd) {
    return prefixed([1, +evenOdd], this._pathSpec(pathObj));
  }
  // …and the one its stroke covers with a `width` pen (canvas_path.rs `Pen`): its caps and joins, and the dash pattern
  // (none for a focus ring).
  _strokeShape(pathObj, width, cap = this._lineCap, join = this._lineJoin, miterLimit = this._miterLimit, dash = this._lineDash) {
    return prefixed([3, width, CAPS.indexOf(cap), JOINS.indexOf(join), miterLimit, this._lineDashOffset || 0, dash.length, ...dash],
                    this._pathSpec(pathObj));
  }
  // A user-space rectangle as a path, through the CTM.
  _rectPath(x, y, w, h) {
    const p = new CanvasPath();
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
    if (path._path.length) this._draw(this._fillShape(path, ruleArg === 'evenodd'), this._paintOf(this._fillObj, this._fill));
  }

  // stroke([path]): the path thickened by the pen (lineWidth, lineCap / lineJoin, the dash pattern) and painted in one
  // nonzero pass — the union covers overlaps exactly once, so a translucent strokeStyle doesn't darken at corners.
  stroke(path) {
    const p = path instanceof CanvasPath ? path : this._pathObj;
    if (p._path.length) this._draw(this._strokeShape(p, this.lineWidth), this._paintOf(this._strokeObj, this._stroke));
  }

  // clip([path,] [fillRule]): intersect the clip region with the given path (or the current default path), so
  // subsequent draws are masked (`__dom.canvasClip`: a pixel is inside where it is at least half covered). Part of the
  // drawing state (save/restore'd); clip() only ever shrinks the region.
  clip(a, b) {
    const path = a instanceof CanvasPath ? a : this._pathObj;
    const ruleArg = a instanceof CanvasPath ? b : a;
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    this._clip = globalThis.__dom.canvasClip(cw, ch, this._fillShape(path, ruleArg === 'evenodd'), this._clip);
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
    if (!element || element.nodeType !== 1) {
      throw new globalThis.TypeError('drawFocusIfNeeded: the element argument is not an Element');
    }
    // Nothing to draw unless the element is the document's focused element AND is
    // fallback content of this canvas (an OffscreenCanvas has no document → never).
    const doc = this.canvas.ownerDocument;
    if (!doc || doc.activeElement !== element) return;
    if (typeof this.canvas.contains !== 'function' || !this.canvas.contains(element)) return;
    // A focus ring is a UA decoration, not an author stroke: build a plain solid
    // outline, ignoring the author's dash pattern and cap/join, and (below) paint it
    // opaque + source-over, ignoring globalAlpha / globalCompositeOperation / shadow —
    // which would otherwise dash it, fade it, shadow it, or (under a whole-canvas
    // operator like 'copy') erase the rest of the canvas. The clip still applies.
    if (path._path.length) this._draw(this._strokeShape(path, 2, 'butt', 'miter', 10, []), this._paintOf(null, {r: 0, g: 0, b: 0, a: 1}), true);
  }

  // ── Text ──────────────────────────────────────────────────────────────
  // Computed font-size (px) of an element via the cascade, or null when it can't
  // be resolved (no CSS set / not a DOM element / OffscreenCanvas).
  _computedFontSize(el) {
    try {
      // Only a CONNECTED element has a meaningful cascaded font-size; a detached canvas
      // (createElement, never inserted) has no document styles, so its relative font
      // sizes must fall back to the canvas default (10px), not getComputedStyle's initial
      // 16px — the caller's `|| 10` / `|| 16` handles the null.
      if (el && el.nodeType === 1 && el.isConnected && globalThis.getComputedStyle) {
        const fs = parseFloat(globalThis.getComputedStyle(el).fontSize);
        if (fs > 0) return fs;
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  // Base px for a font-relative unit: `em`/`%` resolve against the canvas element's
  // computed font-size, `rem` against the root's. When the canvas has no resolvable
  // font-size (detached element / OffscreenCanvas), `em`/`%` fall back to the canvas
  // default font size of 10px (the initial '10px sans-serif'); `rem` to the 16px root
  // default (medium).
  _fontRelBase(unit) {
    if (unit === 'rem') {
      const doc = this.canvas && this.canvas.ownerDocument;
      return this._computedFontSize(doc && doc.documentElement) || 16;
    }
    return this._computedFontSize(this.canvas) || 10;
  }

  // A CSS `font` shorthand computed and serialized as the `font` getter reports it, or null if it does not parse (the
  // style engine's, `__dom.canvasFont`): its size in px, `em` / `%` of the canvas element's font size, `rem` of the
  // root's, `lh` / `rlh` of their line heights (spec: the font is computed at assignment time), its line height left
  // out. A lone system-font keyword is the platform UI font, which is not modelled: one concrete default stands for all.
  _serializeFont(input) {
    const raw = String(input).trim();
    if (FONT_SYSTEM_KW.has(raw.toLowerCase())) return '16px sans-serif';
    // (…the bases asked for only where a relative unit can want them: each is a style read)
    const relative = /em|%|lh/i.test(raw);
    const lh = relative ? this._lineHeightPx(this.canvas, 10) : null;
    const doc = this.canvas && this.canvas.ownerDocument;
    const rlh = relative ? this._lineHeightPx(doc && doc.documentElement, 16) : null;
    return globalThis.__dom.canvasFont(raw, relative ? this._fontRelBase('em') : NaN, relative ? this._fontRelBase('rem') : NaN,
                                       lh == null ? NaN : lh, rlh == null ? NaN : rlh);
  }

  // A CSS <length> unit → px for font sizes. Returns null for a non-length unit.
  _fontUnitToPx(val, unit) {
    switch (unit) {
      case 'px':  return val;
      case 'pt':  return val * 96 / 72;
      case 'pc':  return val * 16;
      case 'in':  return val * 96;
      case 'cm':  return val * 96 / 2.54;
      case 'mm':  return val * 96 / 25.4;
      case 'q':   return val * 96 / 2.54 / 40;
      case 'em':  return val * this._fontRelBase('em');
      case 'rem': return val * this._fontRelBase('rem');
      case 'lh':  { const lh = this._lineHeightPx(this.canvas, 10); return lh != null ? val * lh : null; }
      case 'rlh': { const doc = this.canvas && this.canvas.ownerDocument;
                    const lh = this._lineHeightPx(doc && doc.documentElement, 16); return lh != null ? val * lh : null; }
      default:    return null;
    }
  }

  // The used line-height (px) of `el`, for the `lh` / `rlh` font-size units, resolving
  // every line-height form: an explicit px length; a percentage or bare-number multiplier
  // of the font-size; and 'normal' / unset (≈ 1.2 × font-size). The font-size falls back
  // to `defaultFs` (the canvas / root default) when the element has none, mirroring how
  // em / rem degrade. null only for an OffscreenCanvas (no element to resolve against).
  _lineHeightPx(el, defaultFs) {
    try {
      if (el && el.nodeType === 1 && globalThis.getComputedStyle) {
        const lh = String(globalThis.getComputedStyle(el).lineHeight || '').trim();
        const val = parseFloat(lh);
        if (/px$/i.test(lh) && val > 0) return val;
        const fs = this._computedFontSize(el) || defaultFs;
        if (/%$/.test(lh) && val > 0) return val / 100 * fs;         // percentage of font-size
        if (/^[+-]?[\d.]+$/.test(lh) && val > 0) return val * fs;    // bare-number multiplier
        return fs * 1.2;                                             // 'normal' / unset
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  // Translate the CSS `font` shorthand to a pango font string ("Sans Bold 16")
  // scaled by `scale` (the device font size for a scaled CTM). Size honors px /
  // pt / em / rem / %; bold/italic and the first family are kept.
  _pangoFont(scale) {
    const s = String(this.font || '10px sans-serif').trim();
    // `font` is stored canonically with the size already resolved to px, so the size is
    // the first number bearing a `px` unit — this skips a leading numeric weight (e.g.
    // '700') or oblique angle ('20deg'), which a bare-first-number match would grab.
    const sm = /(-?\d*\.?\d+)px\b/.exec(s);
    const px = sm ? parseFloat(sm[1]) : 10;
    const size = Math.max(1, Math.round(px * (scale || 1)));
    const weight = /\b(bold|[6-9]00)\b/i.test(s) ? ' Bold' : '';
    const style  = /\bitalic\b/i.test(s) ? ' Italic' : (/\boblique\b/i.test(s) ? ' Oblique' : '');
    const variant = this._smallCaps() ? ' Small-Caps' : '';
    const first = this._fontFamily();
    const fam = PANGO_GENERIC[first.toLowerCase()] || first || 'Sans';
    return `${fam}${style}${weight}${variant} ${size}`;
  }

  // Whether small-caps rendering is in effect: the `font` shorthand's small-caps variant,
  // or a non-normal `fontVariantCaps` (pango only models the plain small-caps variant, so
  // every caps keyword maps to it). Only the pre-size portion of the canonical font is
  // inspected for the variant, so a family literally named "small-caps" doesn't match.
  _smallCaps() {
    const s = this._font || '';
    const pre = s.slice(0, s.search(/\d*\.?\d+px\b/));       // style / variant / weight / stretch
    return /\bsmall-caps\b/.test(pre) || (this._fontVariantCaps && this._fontVariantCaps !== 'normal');
  }

  // The first (raw, unquoted) CSS font-family token of the current `font` — the family
  // an @font-face is keyed by, and the one pango is asked for. Memoized on the raw font
  // string (both _pangoFont and _fontFaceURL ask for it on every text op).
  _fontFamily() {
    const s = String(this.font || '10px sans-serif').trim();
    if (this._famFor === s) return this._famVal;
    // Everything after the `<n>px` size token is the family list; take the first item.
    // (The canonical form has no line-height, and the size never follows the weight.)
    const sm = /(-?\d*\.?\d+)px\b/.exec(s);
    const fam = sm ? (s.slice(sm.index + sm[0].length).trim().split(',')[0] || '').trim().replace(/['"]/g, '') : '';
    this._famFor = s; this._famVal = fam;
    return fam;
  }

  // The @font-face src URL for the current font's family (a downloaded face declared
  // in the document's stylesheets), or '' when the family is a system font. The host
  // loads the file so pango can resolve it; system families need no file.
  _fontFaceURL() {
    const doc = this.canvas && this.canvas.ownerDocument;
    if (!doc) return '';
    const family = this._fontFamily();
    return family ? resolveFontFace(doc, family) : '';
  }

  // Current `font` size in px (the canonical form always carries a `px` size).
  _fontSizePx() {
    const sm = /(-?\d*\.?\d+)px\b/.exec(this._font || '10px sans-serif');
    return sm ? parseFloat(sm[1]) : 10;
  }

  // Resolve a letter/word-spacing <length> (already validated by the setter) to px. The
  // font-relative units resolve against the CURRENT font size — unlike the font-size
  // property, spacing is re-resolved on every measure, so changing the font rescales it;
  // absolute units share _fontUnitToPx. (Percentages aren't valid spacing, so the setter
  // never stores one.)
  _spacingPx(v) {
    const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i.exec(String(v).trim());
    if (!m) return 0;
    const val = parseFloat(m[1]), unit = m[2].toLowerCase();
    switch (unit) {
      case 'em':            return val * this._fontSizePx();
      case 'rem':           return val * this._fontRelBase('rem');   // rem is root-relative, not font-relative
      case 'ex': case 'ch': return val * 0.5 * this._fontSizePx();   // x-height / '0'-advance ≈ 0.5em
      case 'ic':            return val * this._fontSizePx();         // ideographic advance ≈ 1em
    }
    // Absolute units (px/pt/pc/in/cm/mm/q) share _fontUnitToPx. Viewport / line-height /
    // container units (vw, lh, cq*, …) that need a subsystem we don't model resolve to 0
    // for now — they still round-trip through the getter (backlog).
    const px = this._fontUnitToPx(val, unit || 'px');
    return px != null ? px : 0;
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
    const font = this._pangoFont(1);                 // user-space units (transform-independent)
    const faceUrl = this._fontFaceURL();
    const kern = this._fontKerning;
    const key = font + '\0' + faceUrl + '\0' + kern + '\0' + text;   // kerning changes the advance
    let m = measureCache.get(key);
    if (!m) {
      const r = globalThis.__csim_renderText ? globalThis.__csim_renderText(text, font, true, faceUrl, kern) : null;
      const asc = r ? r.ascent : 8, desc = r ? r.descent : 2;
      const w = r ? r.width : text.length * 6;                       // ink width (for the box)
      const adv = r ? (r.advance != null ? r.advance : w) : text.length * 6;   // pen advance
      m = {
        width:                    adv,
        // Ink-box edges relative to the text origin: left is positive going left
        // (a positive left side-bearing → negative left), right is the ink's far edge.
        actualBoundingBoxLeft:    r ? -r.xoffset : 0,
        actualBoundingBoxRight:   r ? r.xoffset + w : w,
        actualBoundingBoxAscent:  r ? asc - r.yoffset : asc,
        actualBoundingBoxDescent: r ? (r.yoffset + r.height) - asc : desc,
        fontBoundingBoxAscent:    asc,
        fontBoundingBoxDescent:   desc,
        emHeightAscent:           r && r.emAscent != null ? r.emAscent : asc,
        emHeightDescent:          r && r.emDescent != null ? r.emDescent : desc,
        // The font's BASE table gives exact baselines when present (a downloaded font);
        // otherwise fall back to heuristics off the vertical metrics.
        hangingBaseline:          r && r.hangingBaseline     != null ? r.hangingBaseline     : asc * 0.8,
        alphabeticBaseline:       r && r.alphabeticBaseline  != null ? r.alphabeticBaseline  : 0,
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

  // `letterSpacing` / `wordSpacing` were parsed and MEASURED (`measureText` widens by them) but
  // never DRAWN: the host renders a whole string to one mask, and a mask has no room to open a gap
  // between two glyphs. So a spaced run is drawn one character at a time, each at the pen
  // position the previous one's advance plus the spacing leaves — which is what the spec's
  // "add letter-spacing after each character" means in pixels. Alignment and `maxWidth` are
  // measured on the whole SPACED advance, as they are for an unspaced run, and the condensing
  // factor squashes glyph and gap alike. Returns false to let the ordinary path draw when there
  // is nothing to space (no spacing after resolution, or a single character).
  //
  // The per-character advance is the host's, which for a system font is the rounded INK width
  // rather than the face's advance (8 or 9 where the face says 9.6) — good enough for a page
  // drawing a label, and NOT what the screenshot painter uses: it places a spaced run itself from
  // the layout's own `hmtx` advances (`paint.js`), so its glyphs land exactly where the box says.
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
      // Each character's advance as the DIFFERENCE between two measures of the string with a
      // SENTINEL glyph appended, not a lone glyph's own: the host reports INK widths, so a lone `a`
      // is 8 where the face advances 10, and a trailing space is nothing at all — `ab ` measures
      // the same as `ab`, and the space advanced zero. With an `x` on the end the ink always
      // follows the pen: `ab x` less `abx` is exactly the space's advance, and `ax` less `x` the
      // first character's.
      const measure = (t) => this.measureText(t).width;
      const withSentinel = (i) => measure(chars.slice(0, i).join('') + 'x');
      const advance = (i) => withSentinel(i + 1) - withSentinel(i);
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

  // Render `text` to a coverage mask (real system-font glyphs via the host) and draw it, honoring textAlign /
  // textBaseline and the translate + scale of the CTM, with the fill / stroke paint like any other shape. Rotation /
  // shear of the CTM positions the anchor but doesn't rotate the glyphs.
  _drawText(text, x, y, maxWidth, obj, solid) {
    text = String(text).replace(CANVAS_TEXT_WS, ' ');
    if (!text || !allFinite(x = +x, y = +y)) return;
    // A PROVIDED maxWidth that is ≤ 0 or NaN means "draw nothing" (spec), not "no
    // limit" — distinct from an omitted maxWidth (undefined), which is unconstrained.
    if (maxWidth !== undefined && !(+maxWidth > 0)) return;
    if (this._letterSpacing !== '0px' || this._wordSpacing !== '0px') {
      if (this._drawSpaced(text, x, y, maxWidth, obj, solid)) return;
    }
    if (!this._buffer() || !globalThis.__csim_renderText) return;
    const scale = this._ctmScale() || 1;
    const r = globalThis.__csim_renderText(text, this._pangoFont(scale), false, this._fontFaceURL(), this._fontKerning);
    if (!r || !r.refId) return;
    const mask = fetchTransfer(r.refId);
    if (!mask) return;
    const mwid = r.width | 0, mhei = r.height | 0;
    if (!mwid || !mhei) return;

    // maxWidth CONDENSES the line horizontally (never wraps): squash the mask's x so
    // the rendered advance fits. Alignment and maxWidth are measured on the pen ADVANCE
    // (not the ink box). The device maxWidth is the user value × CTM scale (the mask is
    // already rendered at that scale).
    const advBase = r.advance != null ? r.advance : r.width;   // already device-scaled (mask is)
    const devMax = maxWidth !== undefined ? +maxWidth * scale : 0;   // provided ⇒ already > 0
    const xScale = devMax && advBase > devMax ? devMax / advBase : 1;
    const advance = advBase * xScale;

    const m = this._m;
    const ax = m[0] * x + m[2] * y + m[4], ay = m[1] * x + m[3] * y + m[5];   // device anchor
    const align = this._resolveTextAlign();
    const alignDX = align === 'center' ? advance / 2 : align === 'right' ? advance : 0;
    const lh = r.ascent + r.descent;                 // reference line within the layout box
    const baseY = this.textBaseline === 'top'    ? 0
                : this.textBaseline === 'hanging' ? (r.hangingBaseline != null ? r.ascent - r.hangingBaseline : r.ascent * 0.2)
                : this.textBaseline === 'middle'  ? lh / 2
                // The ideographic baseline sits `ideographicBaseline` above the alphabetic
                // one (BASE table); position it that far up from the alphabetic anchor.
                // Without a BASE table it degrades to the line box bottom (as does bottom).
                : this.textBaseline === 'ideographic' && r.ideographicBaseline != null ? r.ascent - r.ideographicBaseline
                : this.textBaseline === 'bottom' || this.textBaseline === 'ideographic' ? lh
                : r.ascent;                          // alphabetic (default)
    // Ink-box left in device space (the layout, including its x bearing, is
    // condensed by xScale). Output columns are sampled from the source so a
    // condensed run composites each device pixel once (no double-blend).
    const inkX = Math.round(ax - alignDX + r.xoffset * xScale);
    const inkY = Math.round(ay - baseY + r.yoffset);
    const outW = xScale === 1 ? mwid : Math.max(1, Math.round(mwid * xScale));

    const paint = this._paintOf(obj, solid);
    paint.mask = mask;
    this._draw(new globalThis.Float64Array([2, mwid, mhei, inkX, inkY, xScale, outW]), paint);
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
      if (el && el.nodeType === 1 && globalThis.getComputedStyle) {
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
  convertToBlob(options) {
    // A tainted OffscreenCanvas rejects the promise (the async analogue of the sync throw).
    if (canvasTainted(this)) return Promise.reject(new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'));
    return Promise.resolve(canvasEncodeBlob(this, options));
  }
  toBlob(callback, type, quality) {
    if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    scheduleToBlob(this, callback, type, quality);
  }
}

function scheduleToBlob(canvas, callback, type, quality) {
  const cb = typeof callback === 'function' ? callback : function () {};
  queueMicrotask(() => {
    try { cb(canvasEncodeBlob(canvas, {type, quality})); }
    catch (_) { cb(null); }
  });
}

// Pixels → encoded image bytes via libvips. The pixel buffer (in) and
// encoded bytes (out) ride the Ruby-side transfer registry to avoid an
// 8900×8900-RGBA-sized base64 round-trip in JS. The host reports the MIME it
// actually encoded — an unsupported request type comes back as image/png
// (the toBlob / toDataURL fallback rule), so the Blob is labelled to match.
// Returns null only when the host encoder is unavailable.
function encodePixels(pixels, width, height, type, quality) {
  if (typeof globalThis.__csim_encodeImage !== 'function') return null;
  const result = globalThis.__csim_encodeImage(stashTransfer(pixels), width, height, type, quality);
  if (!result) return null;
  const bytes = fetchTransfer(result.refId);
  return bytes ? {bytes, mime: result.mime || type} : null;
}

// Canvas → encoded Blob. A zero-area canvas has no bitmap, so it serializes
// empty; a sized-but-undrawn canvas has an all-transparent bitmap (browsers
// always back a sized canvas), so encode a zeroed buffer rather than nothing.
function canvasEncodeBlob(canvas, options) {
  const opts = options || {};
  const quality = typeof opts.quality === 'number' ? Math.round(opts.quality * 100) : 90;
  const w = canvas.width | 0, h = canvas.height | 0;
  const type = String(opts.type || 'image/png').toLowerCase();
  if (!w || !h) return new globalThis.Blob([''], {type});
  const pixels = canvas._pixels || new globalThis.Uint8ClampedArray(w * h * 4);
  const out = encodePixels(pixels, w, h, type, quality);
  if (!out) return new globalThis.Blob([pixels], {type: 'application/octet-stream'});
  return new globalThis.Blob([out.bytes], {type: out.mime});
}

// Synchronous `data:` serialization. Same encode path as toBlob, base64'd
// inline. A zero-area canvas has no bitmap, so per spec it serializes to the
// empty "data:," URL rather than an image.
function canvasToDataURL(canvas, type, quality) {
  if (!canvas.width || !canvas.height) return 'data:,';
  const blob = canvasEncodeBlob(canvas, {type, quality});
  const mime = blob.type || 'image/png';
  return 'data:' + mime + ';base64,' + latin1ToBytes(blobBytes(blob)).toBase64();
}

export function installCanvasOutputs(ElementCtor) {
  const proto = ElementCtor.prototype;
  if (proto._csimCanvasOutputsInstalled) return;
  proto._csimCanvasOutputsInstalled = true;
  proto.toBlob = function (callback, type, quality) {
    if (this._tag !== 'canvas') {
      const cb = typeof callback === 'function' ? callback : function () {};
      queueMicrotask(() => cb(null));
      return;
    }
    // A tainted canvas throws SYNCHRONOUSLY (before the deferred encode), like getImageData.
    if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    scheduleToBlob(this, callback, type, quality);
  };
  proto.toDataURL = function (type, quality) {
    if (this._tag !== 'canvas') return 'data:,';
    if (canvasTainted(this)) throw new globalThis.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    return canvasToDataURL(this, type, quality);
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
