// The 2D canvas: an RGBA bitmap (`canvasBitmapOf(canvas)`, a Uint8ClampedArray its context's state holds in the
// engine) and the CanvasRenderingContext2D, OffscreenCanvas, ImageData, ImageBitmap, CanvasGradient, CanvasPattern and
// Path2D surfaces over it. What a drawing operation does to the bitmap — its shape's coverage, its paint, the
// compositing operator, the clip, the shadow, the colour space — is native's (canvas.rs, canvas_image.rs), as are
// the drawing state (canvas_state.rs), the paths it builds (canvas_path.rs) and the image file a bitmap is written as
// (image_encode.rs); this side converts the arguments and hands each operation over. An image's bytes decode natively
// too (image_decode.rs), and a line of text is shaped and drawn to a coverage mask natively (text.rs).

import { Blob, blobByteArray, isBlob }                                 from './blob.js';
import { matrix2DComponents, matrixFrom2D } from './geometry.js';
import { fontHandleFor }                                               from './font-metrics.js';
import { documentElementOf } from './document-tree.js';
import { isHtml } from './constants.js';
import { isConnected } from './walk.js';
import {
  IntrinsicPromise, PLATFORM, brandKey, bytesToBase64, constructedBy, interfaceCheck, isCallable,
  isObject, makeSlots, reflectApply, registerInterface, slotsOf,
  inheritInterface,
  NO_ARGUMENTS,
  PlainObject,
  reflectConstruct
} from './webidl.js';
import {
  convertImageDataArguments, convertPath2DArguments, defineCanvasGradient, defineCanvasPattern, defineImageBitmap,
  defineTextMetrics, installCanvasRenderingContext2D,
  convertOffscreenCanvasArguments, installImageData, installOffscreenCanvas, installOffscreenCanvasRenderingContext2D,
  installPath2D, toCanvasRenderingContext2DSettings
} from './generated/bindings.js';
import { EventTarget, installEventHandlerAttrs } from './events.js';
import { UNSIGNED, reflectNumber, setReflectedNumber } from './reflect.js';
import { isImageRequestElement } from './image-request.js';
import { DOMException } from './dom-exception.js';

// ImageData (HTML §4.12.5.1.15), generated from its IDL: its width, height, colour space, pixel format and pixel array
// in its slots. Its two constructors are told apart by their first argument (an ImageDataArray, or a width):
//   new ImageData(sw, sh [, settings])               — transparent black pixels, made for it
//   new ImageData(data, sw [, sh [, settings]])      — the array given, its pixels
// A pixel array of the "rgba-unorm8" format is a Uint8ClampedArray, of "rgba-float16" a Float16Array.
const imageDataOf = (o) => slotsOf(o, 'ImageData');
registerInterface('ImageData', (o) => imageDataOf(o) !== undefined);
const Bytes = Uint8ClampedArray;
// (…why the engine makes none, canvas.rs `IMAGE_DATA_NO_AREA` …: an array's checks past what any size's can be refused for)
const IMAGE_DATA_TAINTED = 2, IMAGE_DATA_TOO_LARGE = 3;
const IMAGE_DATA_WORDS = {
  1: ['The source width or height is zero.', 'IndexSizeError'],
  4: ['The input data length is not a nonzero multiple of the bytes per pixel.', 'InvalidStateError'],
  5: ["The input data length is not a multiple of the width's pixels.", 'IndexSizeError'],
  6: ["The input data length is not the width's and the height's pixels.", 'IndexSizeError'],
  7: ["The input data is not of its pixel format's array type.", 'InvalidStateError']
};
function imageDataRefusal(prefix, refusal) {
  if (refusal === IMAGE_DATA_TOO_LARGE) return new RangeError(prefix + 'Out of memory at ImageData creation.');
  if (refusal === IMAGE_DATA_TAINTED) return new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
  const words = IMAGE_DATA_WORDS[refusal];
  return new DOMException(prefix + words[0], words[1]);
}
const CONSTRUCT_IMAGE_DATA = "Failed to construct 'ImageData': ";
const isFloat16 = (settings) => settings.pixelFormat === 'rgba-float16';
export class ImageData {
  constructor(sw, sh) {
    const args = convertImageDataArguments(arguments);
    if (args[0] === 'sw_sh_settings') {
      const width = args[1], height = args[2], settings = args[3];
      const data = globalThis.__dom.imageDataAllocate(width, height, isFloat16(settings));
      if (typeof data === 'number') throw imageDataRefusal(CONSTRUCT_IMAGE_DATA, data);
      imageDataSlots(this, data, width, height, settings.colorSpace ?? 'srgb', settings.pixelFormat);
    } else {
      const data = args[1], width = args[2], settings = args[4];
      const height = globalThis.__dom.imageDataCheck(data, width, args[3], isFloat16(settings));
      if (height < 0) throw imageDataRefusal(CONSTRUCT_IMAGE_DATA, -height);
      imageDataSlots(this, data, width, height, settings.colorSpace ?? 'srgb', settings.pixelFormat);
    }
  }
}
function imageDataSlots(imageData, data, width, height, colorSpace, pixelFormat) {
  const slots = makeSlots(imageData, 'ImageData');
  slots.width = width;
  slots.height = height;
  slots.data = data;
  slots.colorSpace = colorSpace;
  slots.pixelFormat = pixelFormat;
}
installImageData(ImageData, {});
// A new ImageData of a pixel array the engine made.
function imageDataOfArray(data, width, height, colorSpace, pixelFormat) {
  const imageData = Object.create(ImageData.prototype);
  imageDataSlots(imageData, data, width, height, colorSpace, pixelFormat);
  return imageData;
}

// ImageBitmap (HTML §8.10.1), generated from its IDL: a decoded pixel buffer only the platform makes —
// `createImageBitmap`, `OffscreenCanvas.transferToImageBitmap`, a structured clone or a transfer — its state the
// engine's (image_bitmaps.rs: its RGBA pixels, row-major, a wide-profile source's Display P3 rendering beside them, its
// size, its colour space, whether a cross-origin source tainted it, whether it is closed — [[Detached]]: an unusable
// image source), on the handle its slots keep, which lives as long as it does.
const bitmap = defineImageBitmap({
  init(s, pixels, width, height, { colorSpace = 'srgb', pixelsP3 = null, tainted = false } = {}) {
    const displayP3 = colorSpace === 'display-p3';
    s.state = new globalThis.__dom.ImageBitmapStateBase(pixels, width, height, pixelsP3, displayP3, tainted);
  },
  get_width: (s) => globalThis.__dom.imageBitmapSize(s.state, 0),
  get_height: (s) => globalThis.__dom.imageBitmapSize(s.state, 1),
  close: (s) => globalThis.__dom.imageBitmapClose(s.state)
});
export const ImageBitmap = bitmap.interface;
const BITMAP = brandKey('ImageBitmap');
const bitmapSlotsOf = (o) => slotsOf(o, BITMAP);
// …its state, as the engine holds it: `{pixels, width, height, pixelsP3, colorSpace, tainted, closed}`, its pixels views
// on the engine's — undefined for anything but an ImageBitmap.
function bitmapOf(o) {
  const s = bitmapSlotsOf(o);
  if (s === undefined) return undefined;
  const b = globalThis.__dom.imageBitmapState(s.state);
  return { pixels: b[0], width: b[1], height: b[2], pixelsP3: b[3], colorSpace: b[4] ? 'display-p3' : 'srgb', tainted: b[5], closed: b[6] };
}
// …the DataCloneError of one that cannot be serialized or transferred (image_bitmaps.rs `clone_refusal`) — and its
// structured clone (it is [Serializable]): copies of its pixels, the rest as it is. A transfer is the same clone, the
// source closed once the whole message is serialized (`closeImageBitmap`), as a message that fails to leaves it open.
const BITMAP_DETACHED = 1;
export function checkImageBitmapClone(v, done) {
  const refused = globalThis.__dom.imageBitmapCloneRefusal(bitmapSlotsOf(v).state);
  if (refused === 0) return;
  const what = refused === BITMAP_DETACHED ? 'detached' : 'not origin-clean';
  throw new DOMException(`An ImageBitmap that is ${what} could not be ${done}.`, 'DataCloneError');
}
export function cloneImageBitmap(v) {
  const s = bitmapOf(v);
  return bitmap.create(s.pixels && new Bytes(s.pixels), s.width, s.height,
    { colorSpace: s.colorSpace, pixelsP3: s.pixelsP3 && new Bytes(s.pixelsP3), tainted: s.tainted });
}
export const closeImageBitmap = (v) => globalThis.__dom.imageBitmapClose(bitmapSlotsOf(v).state);

// A <canvas> / OffscreenCanvas source — by what it is, never by asking the page's `getContext`, which would make one
// (with default settings) as it answered.
const isCanvasElement = interfaceCheck('HTMLCanvasElement');

// HTML "check the usability of the image argument", and whether drawing the image taints a canvas, are the engine's
// (canvas_image.rs `judge`), of the source as the bindings classify it: an ImageBitmap's state, a `<canvas>`'s or an
// OffscreenCanvas's (its context's state with it), an image element, a `<video>` — no VideoFrame is made here, and a page's
// own class of that name is none; anything else (a <p>, a plain object) a TypeError.
const SOURCE_BITMAP = 0, SOURCE_CANVAS = 1, SOURCE_OFFSCREEN = 2, SOURCE_IMAGE = 3, SOURCE_VIDEO = 4, SOURCE_NONE = 5;
// (…an image element: an `<img>`, an SVG `<image>`, an `<input type=image>` — a node, of those)
const isImageElement = (src) => src?._tag !== undefined && isImageRequestElement(src);
const VERDICT_GOOD = 0, VERDICT_BAD = 1;
// (…past them, a createPattern repetition that is no keyword's)
const BAD_REPETITION = 6;
function sourceKind(src) {
  if (!isObject(src)) return SOURCE_NONE;
  if (bitmapSlotsOf(src)) return SOURCE_BITMAP;
  if (offscreenOf(src)) return SOURCE_OFFSCREEN;
  if (isCanvasElement(src)) return SOURCE_CANVAS;
  if (isImageElement(src)) return SOURCE_IMAGE;
  return isHtml(src, 'video') ? SOURCE_VIDEO : SOURCE_NONE;
}
const sourceHandle = (src, kind) => (kind === SOURCE_BITMAP ? bitmapSlotsOf(src).state : kind === SOURCE_OFFSCREEN ? offscreenOf(src).state : src);
const sourceContext = (src, kind) => (kind === SOURCE_CANVAS || kind === SOURCE_OFFSCREEN ? surfaceOf(src)._ctx?._state ?? null : null);
// …a failing one an InvalidStateError (`USABILITY_*`, the engine's verdicts), as Chrome words them — `broken` its caller's,
// drawImage's of the element.
const USABILITY_DETACHED = 2, USABILITY_NO_AREA = 3, USABILITY_NO_AREA_OFFSCREEN = 4, USABILITY_BROKEN = 5;
const USABILITY_WORDS = {
  [USABILITY_DETACHED]: 'The image source is detached.',
  [USABILITY_NO_AREA]: 'The image argument is a canvas element with a width or height of 0.',
  [USABILITY_NO_AREA_OFFSCREEN]: 'The image argument is an OffscreenCanvas element with a width or height of 0.'
};
function usabilityError(failure, reason, broken) {
  return new DOMException(failure + (reason === USABILITY_BROKEN ? broken : USABILITY_WORDS[reason]), 'InvalidStateError');
}

// The drawing-state attributes, by the code the engine names each with (canvas_state.rs): CanvasRenderingContext2D's in
// the order its IDL lists them — and those the context's own steps set or read.
const CONTEXT_ATTRIBUTES = [
  'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'strokeStyle', 'fillStyle',
  'shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor', 'filter', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
  'lineDashOffset', 'lang', 'font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'fontKerning',
  'fontStretch', 'fontVariantCaps', 'textRendering', 'wordSpacing'
];
const STROKE_STYLE = 4, FILL_STYLE = 5, SHADOW_COLOR = 9, FONT = 17;
// …what `canvasStack` does to the state: save(), restore(), the state reset to its defaults.
const STATE_SAVE = 0, STATE_RESTORE = 1, STATE_RESET = 2;
// …what `canvasTransform` does to the CTM, or reads of it.
const CTM_TRANSLATE = 0, CTM_SCALE = 1, CTM_ROTATE = 2, CTM_TRANSFORM = 3, CTM_SET = 4, CTM_IDENTITY = 5, CTM_GET = 6;
// …what a drawing op makes of a path: its fill by the nonzero or the even-odd rule, its stroke.
const SHAPE_FILL = 0, SHAPE_FILL_EVEN_ODD = 1, SHAPE_STROKE = 2;
// …the fill and stroke style, by the slot `canvasDrawText` paints with one.
const PAINT_FILL = 0, PAINT_STROKE = 1;
// …what `canvasRect` does with a rectangle.
const RECT_FILL = 0, RECT_CLEAR = 1, RECT_STROKE = 2;


// `createImageBitmap(image[, sx, sy, sw, sh][, options])` — async factory, its arguments the bindings' to convert (the
// crop rectangle `crop` — `[sx, sy, sw, sh]`, each a `long` — or null, and an ImageBitmapOptions), its steps the engine's
// (canvas_image.rs), which hand back a bitmap's parts or why they refuse. Rejection contract (per the HTML spec, in this
// order): a given sw/sh of 0 → RangeError; a resizeWidth/resizeHeight of 0 → InvalidStateError; a recognized-but-unusable
// source (empty / broken image, zero-area or oversized canvas, closed ImageBitmap, undecodable Blob, detached ImageData)
// → InvalidStateError; anything that isn't an image source at all → TypeError.
// HTML settles the promise of a bitmap it made by a global task on the bitmap task source, "Queue a global task, using the
// bitmap task source, to resolve promise with imageBitmap", as it rejects one for a Blob that does not decode; the rest of
// its refusals return a rejected promise.
const CROP_NO_AREA = 6, UNDECODABLE = 7;
export function createImageBitmap(source, crop, options) {
  return new IntrinsicPromise((resolve, reject) => {
    const steps = new Float64Array(9);
    steps[0] = +(crop !== null);
    if (crop !== null) for (let i = 0; i < 4; i++) steps[i + 1] = crop[i];
    steps[5] = options.resizeWidth ?? NaN;
    steps[6] = options.resizeHeight ?? NaN;
    steps[7] = +(options.imageOrientation === 'flipY');
    steps[8] = +(options.colorSpaceConversion === 'none');
    const imageData = imageDataOf(source), kind = sourceKind(source);
    let made;
    if (isBlob(source)) {
      made = globalThis.__dom.imageBitmapOfBlob(steps, blobByteArray(source));
    } else if (imageData) {
      made = globalThis.__dom.imageBitmapOfImageData(steps, imageData.data, imageData.pixelFormat === 'rgba-float16', imageData.colorSpace, imageData.width, imageData.height);
    } else if (kind !== SOURCE_NONE) {
      made = globalThis.__dom.imageBitmapOfSource(steps, kind, sourceHandle(source, kind), sourceContext(source, kind));
    } else {
      return reject(new TypeError('createImageBitmap: unsupported image source'));
    }
    if (made === UNDECODABLE) return globalThis.__csimSetTimeout(() => reject(imageBitmapRefusal(VERDICT_BAD)), 0);
    if (typeof made === 'number') return reject(imageBitmapRefusal(made));
    const created = bitmap.create(made[0], made[1], made[2], { colorSpace: made[4] ? 'display-p3' : 'srgb', pixelsP3: made[3], tainted: made[5] });
    globalThis.__csimSetTimeout(() => resolve(created), 0);
  });
}
function imageBitmapRefusal(refusal) {
  if (refusal === CROP_NO_AREA) return new RangeError('createImageBitmap: the crop rect width and height must be non-zero');
  if (refusal === VERDICT_BAD) return new DOMException('the image argument is not usable', 'InvalidStateError');
  return usabilityError('', refusal, 'The image element contains no image data.');
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
// TextMetrics (HTML §4.12.5.1.10), generated from its IDL: the metrics a measureText found, as the engine answers them
// (canvas_text.rs `canvasMeasureText`: in the order of `METRICS`).
const METRICS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'emHeightAscent',
  'emHeightDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline'
];
const textMetrics = defineTextMetrics({
  init(s, metrics) { s.metrics = metrics; },
  ...Object.fromEntries(METRICS.map((name, i) => ['get_' + name, (s) => s.metrics[i]]))
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
  init(s, paint) { s.paint = paint; },
  // setTransform(): the pattern sampled in a space transformed by the matrix of the 2D dictionary (a DOMMatrix's members
  // or an a–f / m11–m42 one; an inconsistent one a TypeError) — one with a non-finite member leaving it as it was.
  setTransform(s, transform) {
    const m = matrix2DComponents(transform);
    globalThis.__dom.canvasPatternTransform(s.paint, m[0], m[1], m[2], m[3], m[4], m[5]);
  }
});
const PATTERN = brandKey('CanvasPattern');
const patternOf = (o) => slotsOf(o, PATTERN);
// A gradient made, of `kind` and its geometry (`a` to `f`, as many as the kind has): its paint, and its interface
// object, which the paint traces back.
function newGradient(kind, a, b, c, d, e, f) {
  const paint = new globalThis.__dom.CanvasPaintBase();
  const made = gradient.create(paint);
  return globalThis.__dom.canvasGradientInit(paint, made, kind, a, b, c, d, e, f) ? made : null;
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
const PATH_OP = {moveTo: 0, lineTo: 1, closePath: 2, rect: 3, bezierCurveTo: 5, quadraticCurveTo: 6,
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
    if (Array.isArray(r)) throw r[0] === 'RangeError' ? new RangeError(r[1]) : new DOMException(r[1], r[0]);
    if (r) this._buf = r;
  }
  _op(op, a, b, c, d, e, f, g, h) {
    this._took(globalThis.__dom.canvasPath(this._buf, op, this._state, a, b, c, d, e, f, g, h));
  }
  reset() { this._op(PATH_OP.reset); }

  // (…every number one already, the binding's conversion or the painter's own, and an anticlockwise flag made one)
  moveTo(x, y) { this._op(PATH_OP.moveTo, x, y); }
  lineTo(x, y) { this._op(PATH_OP.lineTo, x, y); }
  closePath() { this._op(PATH_OP.closePath); }
  rect(x, y, w, h) { this._op(PATH_OP.rect, x, y, w, h); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this._op(PATH_OP.bezierCurveTo, c1x, c1y, c2x, c2y, x, y); }
  quadraticCurveTo(cx, cy, x, y) { this._op(PATH_OP.quadraticCurveTo, cx, cy, x, y); }
  arc(x, y, r, a0, a1, ccw) { this._op(PATH_OP.arc, x, y, r, a0, a1, +ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) { this._op(PATH_OP.ellipse, x, y, rx, ry, rot, a0, a1, +ccw); }
  arcTo(x1, y1, x2, y2, r) { this._op(PATH_OP.arcTo, x1, y1, x2, y2, r); }
  // `radii`: `(unrestricted double or DOMPointInit or sequence<(unrestricted double or DOMPointInit)>)`, told apart as
  // WebIDL tells a union: an object (a function too) with an `@@iterator` method a sequence, each element converted as
  // it is iterated; any other object, or null, a DOMPointInit; anything else a number.
  roundRect(x, y, w, h, radii = 0) {
    const method = isObject(radii) ? radii[Symbol.iterator] : undefined;
    // (…the four the engine can take, own elements no setter on `Array.prototype` sees, and how many a page's iterator gave)
    const list = { radii: [0, 0, 0, 0, 0, 0, 0, 0], count: 0 };
    if (method === undefined || method === null) {
      pushRadius(list, radii);
    } else {
      if (!isCallable(method)) throw new TypeError('roundRect: the radii are not iterable');
      for (const v of {[Symbol.iterator]: () => reflectApply(method, radii, [])}) pushRadius(list, v);
    }
    const r = list.radii;
    this._took(globalThis.__dom.canvasPathRoundRect(this._buf, this._state, x, y, w, h, list.count, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]));
  }
}
// A radius, `(unrestricted double or DOMPointInit)`, as its x and y: an object, or null or undefined, a DOMPointInit, its
// members (w, x, y, z) read and converted in order; else a number for both axes.
function pushRadius(list, v) {
  let rx, ry;
  if (v !== null && v !== undefined && !isObject(v)) {
    rx = ry = +v;
  } else {
    const member = k => { const m = v?.[k]; return m === undefined ? 0 : +m; };
    member('w');
    rx = member('x');
    ry = member('y');
    member('z');
  }
  const at = list.count++ * 2;
  if (at < 8) {
    list.radii[at] = rx;
    list.radii[at + 1] = ry;
  }
}

// Path2D (HTML §4.12.5.1.6), generated from its IDL: a standalone path usable with fill(path) / stroke(path) /
// clip(path) / isPointInPath(path, …), its PathBuilder in its slots — built from the CanvasPath methods, copied from
// another Path2D (any realm's), or read from SVG path data.
const pathOf = (o) => slotsOf(o, 'Path2D')?.path;
registerInterface('Path2D', (o) => pathOf(o) !== undefined);
export class Path2D {
  constructor(path) {
    path = convertPath2DArguments(arguments)[0];
    const builder = new PathBuilder();
    const other = pathOf(path);
    if (other) builder._buf = other._buf.slice();
    else if (path !== undefined) builder._took(globalThis.__dom.canvasPathSvg(builder._buf, path));
    makeSlots(this, 'Path2D').path = builder;
  }
}
installPath2D(Path2D, {
  // addPath(): another path's subpaths appended through the matrix of the 2D dictionary given (the identity where none
  // is) — nothing for a path of none, before that matrix is made (and an inconsistent one refused: the dictionary's
  // conversion is this side's), nor where it has a non-finite member (canvas_path.rs `canvasPathAdd`).
  addPath(self, path, transform) {
    const added = pathOf(path);
    if (added._empty) return;
    const builder = pathOf(self);
    builder._took(globalThis.__dom.canvasPathAdd(builder._buf, added._buf, matrix2DComponents(transform)));
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
  // (…the PredefinedColorSpace its bitmap holds values in)
  get _colorSpace() { return globalThis.__dom.canvasColorSpace(this._state); }

  // (…`options` getContext's, converted to a CanvasRenderingContext2DSettings as the context is made: `prefix` the
  // message's)
  constructor(canvas, options, Interface, prefix) {
    this._canvas = canvas;
    // (…"if options is not an object, then set options to null", getContext's step before the conversion)
    const settings = toCanvasRenderingContext2DSettings(isObject(options) ? options : null, prefix);
    // (…those settings and its drawing state the engine's: canvas_state.rs)
    const size = canvasSize(canvas);
    this._state = new globalThis.__dom.CanvasStateBase(settings, size[0], size[1]);
    this._newPath();
    this.wrapper = new Interface(PLATFORM, this);   // the interface's object, which the page holds
    this._interface = Interface.name;
  }

  // (…the current default path, empty, which bakes the CTM into each point: the rest of a context's reset the engine's,
  // `canvasStack`'s and `canvasResize`'s)
  _newPath() { this._pathObj = new PathBuilder(this._state); }

  // A drawing-state attribute (its code: `CONTEXT_ATTRIBUTES`), read and written as the engine has it — each setter
  // ignoring a value out of its range. A fill or stroke style that is a gradient or a pattern is that object; a colour
  // resolves `currentColor` to the canvas element's colour, asked only where the value names it; a `font` its relative
  // units against the bases they want, asked only where it may have one.
  _get(attribute) { return globalThis.__dom.canvasGet(this._state, attribute); }
  _set(attribute, value) {
    const state = this._state;
    if (attribute === FILL_STYLE || attribute === STROKE_STYLE || attribute === SHADOW_COLOR) {
      const paint = attribute !== SHADOW_COLOR ? paintOf(value) : undefined;
      if (paint !== undefined) return globalThis.__dom.canvasSet(state, attribute, paint, true);
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
    const made = newGradient(RADIAL_GRADIENT, x0, y0, r0, x1, y1, r1);
    if (!made) throw new DOMException('negative radius', 'IndexSizeError');
    return made;
  }
  createConicGradient(startAngle, x, y) {
    return newGradient(CONIC_GRADIENT, startAngle, x, y);
  }

  // createPattern(image, repetition): a tiled-image fill/stroke style — HTML's steps in their order: the image's usability
  // checked first (an InvalidStateError for a failing one, `null` for a bad one — a still-loading, srcless or zero-size
  // image, a video with no frame — whatever the repetition), then an empty repetition (null too, by the binding's
  // [LegacyNullToEmptyString]) 'repeat', any other non-keyword (`undefined` → "undefined" included) a SyntaxError.
  createPattern(image, repetition) {
    // (…none that is no CanvasImageSource, a type error the binding's union refuses before)
    const kind = sourceKind(image);
    if (kind === SOURCE_NONE) throw new TypeError('createPattern: the image is not a usable image source');
    const paint = new globalThis.__dom.CanvasPaintBase();
    const made = pattern.create(paint);
    const repeats = PATTERN_REPS.indexOf(repetition === '' ? 'repeat' : repetition);
    const refused = globalThis.__dom.canvasCreatePattern(paint, made, this._state, kind, sourceHandle(image, kind), sourceContext(image, kind), repeats);
    if (refused === VERDICT_BAD) return null;
    if (refused === BAD_REPETITION) throw new DOMException('bad repetition', 'SyntaxError');
    if (refused !== VERDICT_GOOD) throw usabilityError(this._failure('createPattern'), refused, "Source image is in the 'broken' state.");
    return made;
  }

  // The drawing-state stack, the engine's: save() pushes a copy of the state — its transform, clip, styles and the rest —
  // and restore() pops it back (none: nothing). The current path is NOT part of it: it persists across them, per spec.
  save() { globalThis.__dom.canvasStack(this._state, STATE_SAVE); }
  restore() { globalThis.__dom.canvasStack(this._state, STATE_RESTORE); }
  // setLineDash(segments): ignored where a segment is negative or not finite, an odd list doubled — the engine's.
  setLineDash(segments) {
    const dash = new Float64Array(segments.length);
    for (let i = 0; i < dash.length; i++) dash[i] = segments[i];
    globalThis.__dom.canvasLineDash(this._state, dash);
  }
  getLineDash() { return globalThis.__dom.canvasLineDash(this._state); }

  // The current transformation matrix, the engine's to multiply: each transform method a no-op where an argument is not
  // finite (NaN / ±Infinity) — the matrix kept rather than poisoned. setTransform(transform) takes the matrix of a 2D
  // dictionary (the identity where none is given).
  translate(x, y) { globalThis.__dom.canvasTransform(this._state, CTM_TRANSLATE, x, y); }
  scale(x, y) { globalThis.__dom.canvasTransform(this._state, CTM_SCALE, x, y); }
  rotate(rad) { globalThis.__dom.canvasTransform(this._state, CTM_ROTATE, rad); }
  transform(a, b, c, d, e, f) { globalThis.__dom.canvasTransform(this._state, CTM_TRANSFORM, a, b, c, d, e, f); }
  setTransform(a, b, c, d, e, f) { globalThis.__dom.canvasTransform(this._state, CTM_SET, a, b, c, d, e, f); }
  setTransformMatrix(transform) {
    const m = matrix2DComponents(transform);
    globalThis.__dom.canvasTransform(this._state, CTM_SET, m[0], m[1], m[2], m[3], m[4], m[5]);
  }
  resetTransform() { globalThis.__dom.canvasTransform(this._state, CTM_IDENTITY); }
  // getTransform() — the current CTM as a fresh (2D) DOMMatrix.
  getTransform() {
    const m = this._ctm();
    return matrixFrom2D(m[0], m[1], m[2], m[3], m[4], m[5]);
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

  // ── Drawing: one operation, handed to the rasterizer ──
  // The draw-path operations take the path given — a Path2D's PathBuilder — or null for the current default path, and
  // are the engine's (canvas.rs `canvasDrawPath`, `canvasClip`, canvas_path.rs `canvasHit`).
  //
  // fill([path,] fillRule): rasterize the path, subpaths implicitly closed, under the winding rule.
  _drawPath(path, how) {
    path ??= this._pathObj;
    globalThis.__dom.canvasDrawPath(this._state, how, path._buf, path._baked);
  }
  fill(path, fillRule) { this._drawPath(path, fillRule === 'evenodd' ? SHAPE_FILL_EVEN_ODD : SHAPE_FILL); }

  // stroke([path]): the path thickened by the pen (lineWidth, lineCap / lineJoin, the dash pattern) and painted in one
  // nonzero pass — the union covers overlaps exactly once, so a translucent strokeStyle doesn't darken at corners.
  stroke(path) { this._drawPath(path, SHAPE_STROKE); }

  // clip([path,] fillRule): intersect the clip region with the path, so subsequent draws are masked. Part of the drawing
  // state (save/restore'd); clip() only ever shrinks the region.
  clip(path, fillRule) {
    path ??= this._pathObj;
    globalThis.__dom.canvasClip(this._state, fillRule === 'evenodd' ? SHAPE_FILL_EVEN_ODD : SHAPE_FILL, path._buf, path._baked);
  }

  // isPointInPath([path,] x, y, fillRule) — is the point, in canvas coordinate space (unaffected by the current
  // transform), inside the path under the winding rule, as fill() would paint it (`__dom.canvasHit`)? A point exactly
  // on the boundary is inside; under a non-invertible CTM nothing is.
  isPointInPath(path, x, y, fillRule) {
    path ??= this._pathObj;
    return globalThis.__dom.canvasHit(this._state, fillRule === 'evenodd' ? SHAPE_FILL_EVEN_ODD : SHAPE_FILL, path._buf, path._baked, x, y);
  }

  // isPointInStroke([path,] x, y) — is the point (in canvas coordinate space) on the stroke? Tested against the stroke
  // stroke() would paint, so caps, joins, a non-uniform pen and the dash pattern are all honoured exactly (a point just
  // past a butt-capped dash end is outside).
  isPointInStroke(path, x, y) {
    path ??= this._pathObj;
    return globalThis.__dom.canvasHit(this._state, SHAPE_STROKE, path._buf, path._baked, x, y);
  }

  // Reset the bitmap to transparent black and the context to its default state.
  reset() {
    globalThis.__dom.canvasStack(this._state, STATE_RESET);
    this._newPath();
  }
  getContextAttributes() { return globalThis.__dom.canvasContextAttributes(this._state); }
  isContextLost() { return false; }
  // drawFocusIfNeeded([path,] element): if `element` is focused and is fallback
  // content of this canvas, draw a focus ring along the path — so keyboard / AT users
  // can see which control the path represents. A real UA paints a platform-styled ring;
  // we stroke a 2px opaque outline of the path, which satisfies the observable contract
  // (the canvas changes only when the associated element is actually focused).
  drawFocusIfNeeded(path, element) {
    path ??= this._pathObj;
    globalThis.__dom.canvasFocusRing(this._state, this.canvas, element, path._buf, path._baked);
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
    const own = this._fontBase(this.canvas, 10), root = this._rootBase(), bases = new Float64Array(4);
    bases[0] = own ? own.fs : 10;
    bases[1] = root ? root.fs : 16;
    bases[2] = own ? own.lh : NaN;
    bases[3] = root ? root.lh : NaN;
    return bases;
  }

  // What a text op is answered with (`__dom.canvasFontFace` says which it wants: `[bucket, family, inherits, rem]`): the
  // face the font's family stack resolves to in the bucket its weight and style fall in — as a page's text does
  // (font-metrics.js: its `@font-face` where the document declares one, else the system face fontconfig gives it) — its
  // native handle (font.rs), which the engine shapes and draws the line with; the canvas element's direction, where the
  // state's inherits it; the root's font size, where a spacing is in `rem`.
  _face(asked) { return fontHandleFor(asked[1], asked[0]); }
  _rootSize(asked) { return asked[3] ? this._rootFontSize() : 16; }
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
    const asked = globalThis.__dom.canvasFontFace(this._state);
    return textMetrics.create(globalThis.__dom.canvasMeasureText(this._state, text, this._face(asked), asked[2] && this._inheritedRtl(), this._rootSize(asked)));
  }

  // fillText / strokeText: the line drawn at (x, y) with the fill or the stroke style, condensed to `maxWidth` — the
  // engine's (canvas_text.rs `canvasDrawText`). strokeText is approximated as a filled glyph (glyph-outline stroking
  // isn't modeled) — the common use is a visible label; the fill/stroke colour differs.
  fillText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, PAINT_FILL); }
  strokeText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, PAINT_STROKE); }
  _drawText(text, x, y, maxWidth, slot) {
    const asked = globalThis.__dom.canvasFontFace(this._state);
    globalThis.__dom.canvasDrawText(this._state, text, x, y, maxWidth, slot, this._face(asked), asked[2] && this._inheritedRtl(), this._rootSize(asked));
  }

  // fillRect, clearRect, strokeRect: the engine's, its early returns with them (canvas.rs `canvasRect`).
  fillRect(x, y, w, h) { globalThis.__dom.canvasRect(this._state, RECT_FILL, x, y, w, h); }
  clearRect(x, y, w, h) { globalThis.__dom.canvasRect(this._state, RECT_CLEAR, x, y, w, h); }
  strokeRect(x, y, w, h) { globalThis.__dom.canvasRect(this._state, RECT_STROKE, x, y, w, h); }

  // drawImage(): `source` a CanvasImageSource (the binding's union), drawn from its rectangle (sx, sy, sw, sh) to
  // (dx, dy, dw, dh) — the sizes it does not give undefined — HTML's steps in their order the engine's (canvas_image.rs
  // `canvasDrawImage`), which answers the reason a failing source is an InvalidStateError.
  drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    const kind = sourceKind(source);
    const failing = globalThis.__dom.canvasDrawImage(this._state, kind, sourceHandle(source, kind), sourceContext(source, kind), sx, sy, sw, sh, dx, dy, dw, dh);
    if (failing) throw usabilityError(this._failure('drawImage'), failing, "The HTMLImageElement provided is in the 'broken' state.");
  }

  // getImageData(): the rectangle's pixels, read and refused by the engine (canvas.rs `canvasGetImageData`), in the colour
  // space the settings ask for, this context's where they name none.
  getImageData(x, y, w, h, settings) {
    const colorSpace = settings.colorSpace ?? this._colorSpace;
    const data = globalThis.__dom.canvasGetImageData(this._state, x, y, w, h, isFloat16(settings), colorSpace);
    if (typeof data === 'number') throw imageDataRefusal(this._failure('getImageData'), data);
    return imageDataOfArray(data, Math.abs(w), Math.abs(h), colorSpace, settings.pixelFormat);
  }

  // putImageData(): an ImageData's (`image` its slots) dirty rectangle — the whole of it where none is given — put at
  // (dx, dy), the engine's (canvas.rs `canvasPutImageData`); one whose array's buffer is detached an InvalidStateError.
  putImageData(image, dx, dy, drX, drY, drW, drH) {
    const detached = globalThis.__dom.canvasPutImageData(this._state, image.data, image.pixelFormat === 'rgba-float16', image.colorSpace,
                                                         image.width, image.height, dx, dy, drX, drY, drW, drH);
    if (detached) throw new DOMException(this._failure('putImageData') + 'The source data has been detached.', 'InvalidStateError');
  }

  // createImageData(): a new ImageData of transparent black — the absolute magnitude of the size given, and its
  // settings, in this context's colour space where they name none — and createImageDataLike(), of the size and settings
  // of an ImageData (`image` its slots).
  createImageData(sw, sh, settings) {
    return this._blankImageData(Math.abs(sw), Math.abs(sh), settings);
  }
  createImageDataLike(image) {
    return this._blankImageData(image.width, image.height, image);
  }
  _blankImageData(w, h, settings) {
    const data = globalThis.__dom.imageDataAllocate(w, h, isFloat16(settings));
    if (typeof data === 'number') throw imageDataRefusal(this._failure('createImageData'), data);
    return imageDataOfArray(data, w, h, settings.colorSpace ?? this._colorSpace, settings.pixelFormat);
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
    makeSlots(this, 'CanvasRenderingContext2D').engine = engine;
  }
}
const offscreenEngineOf = (o) => slotsOf(o, 'OffscreenCanvasRenderingContext2D')?.engine;
registerInterface('OffscreenCanvasRenderingContext2D', (o) => offscreenEngineOf(o) !== undefined);
export class OffscreenCanvasRenderingContext2D {
  constructor(token, engine) {
    constructedBy(PLATFORM, token, 'OffscreenCanvasRenderingContext2D');
    makeSlots(this, 'OffscreenCanvasRenderingContext2D').engine = engine;
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

// OffscreenCanvas (HTML §4.12.5.3), generated from its IDL: an EventTarget whose size and whether a transfer detached it
// are the engine's (offscreen_canvas.rs, its slots' `state`), its context in its slots — under the name a <canvas>
// element keeps its own by, so one `surfaceOf` serves both — and its bitmap its context's, the engine's
// (`canvasBitmapOf`).
const offscreenOf = (o) => slotsOf(o, 'OffscreenCanvas');
registerInterface('OffscreenCanvas', (o) => offscreenOf(o) !== undefined);
export class OffscreenCanvas extends Object {
  constructor(width, height) {
    const size = convertOffscreenCanvasArguments(arguments);
    width = size[0];
    height = size[1];
    const self = reflectConstruct(PlainObject, NO_ARGUMENTS, new.target);
    const slots = makeSlots(self, 'OffscreenCanvas');
    slots.state = new globalThis.__dom.OffscreenCanvasStateBase(width, height);
    slots._ctx = null;
    return self;
  }
}
inheritInterface(OffscreenCanvas, EventTarget);
// …its width and height, and whether it is detached, as its slots `s` say.
const offscreenSize = (s) => [globalThis.__dom.offscreenCanvasSize(s.state, 0), globalThis.__dom.offscreenCanvasSize(s.state, 1)];
const offscreenDetached = (s) => globalThis.__dom.offscreenCanvasDetached(s.state);
// A canvas's context: an OffscreenCanvas's slots, a <canvas> element's own.
const surfaceOf = (canvas) => offscreenOf(canvas) ?? canvas;
// …and its bitmap, its 2D context state's in the engine (`canvasBitmap`) — none where nothing was drawn since it was
// made, reset or resized (transparent black), nor with no context.
export function canvasBitmapOf(canvas) {
  const ctx = surfaceOf(canvas)._ctx;
  return ctx ? globalThis.__dom.canvasBitmap(ctx._state) : null;
}
// …its width and height, an OffscreenCanvas's (the engine's) or a <canvas>'s attributes — never the members a page may
// replace —
export function canvasSize(canvas) {
  const offscreen = offscreenOf(canvas);
  if (offscreen) return offscreenSize(offscreen);
  return [htmlCanvasElementMembers.get_width(canvas), htmlCanvasElementMembers.get_height(canvas)];
}
// The painter's surface (paint.js): an OffscreenCanvas of the platform's own and its 2D context's ENGINE — what a page's
// replaced `createElement`, `getContext` or context members never stand in for — and a context attribute set on it as
// the binding's setter would, after its conversion.
export const paintSurface = (width, height) => new Context2D(new OffscreenCanvas(width, height), null, OffscreenCanvasRenderingContext2D, '');
export const surfacePixels = (engine) => globalThis.__dom.canvasBitmap(engine._state);
export const setContextAttribute = (engine, name, value) => engine._set(CONTEXT_ATTRIBUTES.indexOf(name), value);
export const contextAttributeName = (attribute) => CONTEXT_ATTRIBUTES[attribute];
// A canvas's bitmap reset to transparent black (sized anew) and its 2D context's state (transform, clip, styles) — an
// OffscreenCanvas's width or height assigned, a <canvas>'s `width` / `height` attribute set (dom-nodes.js), even to the
// value it had: the `canvas.width = canvas.width` clear idiom.
export function resetBitmap(canvas) {
  const ctx = surfaceOf(canvas)._ctx;
  if (!ctx) return;
  const size = canvasSize(canvas);
  globalThis.__dom.canvasResize(ctx._state, size[0], size[1]);
  ctx._newPath();
}
function resize(canvas, axis, v) {
  globalThis.__dom.offscreenCanvasResize(offscreenOf(canvas).state, axis, v);
  resetBitmap(canvas);
}
installOffscreenCanvas(OffscreenCanvas, {
  get_width: (canvas) => globalThis.__dom.offscreenCanvasSize(offscreenOf(canvas).state, 0),
  set_width: (canvas, v) => resize(canvas, 0, v),
  get_height: (canvas) => globalThis.__dom.offscreenCanvasSize(offscreenOf(canvas).state, 1),
  set_height: (canvas, v) => resize(canvas, 1, v),
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
    const size = offscreenSize(s);
    return bitmap.create(globalThis.__dom.canvasTakeBitmap(s._ctx._state), size[0], size[1],
      { colorSpace: s._ctx._colorSpace.replace(/-linear$/, ''), tainted: !globalThis.__dom.canvasOriginClean(s._ctx._state) });
  },
  // convertToBlob(): a tainted bitmap and one with no pixels reject at once, in that order; the bitmap is serialised
  // at the call, and the promise settled in a task: with the Blob, or an EncodingError.
  convertToBlob(canvas, options) {
    const s = offscreenOf(canvas);
    detachedCheck(s, 'convertToBlob');
    const file = encodedFile(canvas, options.type, options.quality ?? NaN);
    if (file === ENCODE_NO_PIXELS) throw new DOMException('The canvas has no pixels.', 'IndexSizeError');
    const blob = fileBlob(file);
    return new IntrinsicPromise((resolve, reject) => globalThis.__csimSetTimeout(() => {
      if (blob) resolve(blob);
      else reject(new DOMException('The bitmap could not be encoded.', 'EncodingError'));
    }, 0));
  },
  installEventHandlers: installEventHandlerAttrs
});
// (…one transferred away is detached: what it was asked to do is an InvalidStateError)
function detachedCheck(s, op) {
  if (offscreenDetached(s)) throw new DOMException(`Failed to execute '${op}' on 'OffscreenCanvas': The OffscreenCanvas is detached.`, 'InvalidStateError');
}
// …and its transfer (it is [Transferable]): refused for one detached already (a DataCloneError) or with a context (an
// InvalidStateError, its transfer steps'); then a new one of its size, a bitmap of transparent black — the source
// detached, its bitmap unset, once the whole message is serialized (`detachOffscreenCanvas`).
const TRANSFER_DETACHED = 1, TRANSFER_HAS_CONTEXT = 2;
export function checkOffscreenCanvasTransfer(v) {
  const s = offscreenOf(v), refused = globalThis.__dom.offscreenCanvasTransferRefusal(s.state, s._ctx !== null);
  if (refused === TRANSFER_DETACHED) throw new DOMException('An OffscreenCanvas could not be transferred because it was detached.', 'DataCloneError');
  if (refused === TRANSFER_HAS_CONTEXT) throw new DOMException('An OffscreenCanvas could not be transferred because it had a rendering context.', 'InvalidStateError');
}
export function transferredOffscreenCanvas(v) {
  const size = offscreenSize(offscreenOf(v));
  return new OffscreenCanvas(size[0], size[1]);
}
export function detachOffscreenCanvas(v) {
  globalThis.__dom.offscreenCanvasDetach(offscreenOf(v).state);
}

// The canvas's bitmap serialised as an image file (image_encode.rs `canvasEncode`): `[mime, bytes]` — an unsupported type is
// PNG — why not (a SecurityError for a tainted one, thrown here, and `ENCODE_NO_PIXELS`), or null for a size the format
// cannot hold. `type` is a string and `quality` a number already, NaN for none.
const ENCODE_TAINTED = 1, ENCODE_NO_PIXELS = 2;
function encodedFile(canvas, type, quality) {
  const ctx = surfaceOf(canvas)._ctx, size = canvasSize(canvas);
  const file = globalThis.__dom.canvasEncode(ctx ? ctx._state : null, size[0], size[1], type, quality);
  if (file === ENCODE_TAINTED) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
  return file;
}
// toBlob / toDataURL's `quality` (`any`: only a Number is one, NaN for none).
const qualityOf = (quality) => typeof quality === 'number' ? quality : NaN;
// …a file as a Blob, or null for none.
const fileBlob = (file) => (isObject(file) ? new Blob([file[1]], {type: file[0]}) : null);

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
    const blob = fileBlob(encodedFile(canvas, type, qualityOf(quality)));
    globalThis.__csimSetTimeout(() => callback(blob), 0);
  },
  toDataURL(canvas, type, quality) {
    const file = encodedFile(canvas, type, qualityOf(quality));
    return isObject(file) ? 'data:' + file[0] + ';base64,' + bytesToBase64(file[1]) : 'data:,';
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
      checkImageBitmapClone(v, 'cloned');
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
      const size = offscreenSize(c);
      return { __csimType: 'OffscreenCanvas', width: size[0], height: size[1] };
    }
    return undefined;
  },
  fromRecord(r) {
    if (r.__csimType === 'ImageBitmap') {
      return bitmap.create(fromByteView(r.pixels), r.width, r.height, { colorSpace: r.colorSpace, tainted: r.tainted, pixelsP3: fromByteView(r.pixelsP3) });
    }
    if (r.__csimType === 'OffscreenCanvas') return new OffscreenCanvas(r.width, r.height);
    return imageDataOfArray(globalThis.__dom.imageDataArrayOver(r.data, isFloat16(r)), r.width, r.height, r.colorSpace, r.pixelFormat);
  },
  checkTransfer(t) {
    if (bitmapSlotsOf(t)) checkImageBitmapClone(t, 'transferred');
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
globalThis.TextMetrics              = textMetrics.interface;
globalThis.CanvasPattern            = pattern.interface;
globalThis.Path2D                   = Path2D;
globalThis.OffscreenCanvas          = OffscreenCanvas;
