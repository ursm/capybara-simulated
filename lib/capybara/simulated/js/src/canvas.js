// Pixel buffer / Canvas surface — Tesseract.js (and any image-
// processing library aimed at Workers) reads pixels via the chain
// `createImageBitmap(blob) → OffscreenCanvas.drawImage →
// ctx.getImageData`. We don't render anything visual; the bitmap-
// buffer + drawImage blit + RGBA readback is all that matters for
// OCR. Image decoding outsources to libvips through
// `__csim_decodeImage` (PNG / JPEG / WebP / GIF — anything libvips
// supports). Vector primitives (fillRect, beginPath, etc.) are
// no-ops — libraries that actually need rasterised vector output
// won't get it, but they don't crash either.

import { fetchedToBytes, fetchTransfer, stashTransfer } from './bytes.js';
import { blobBytes }                                                   from './blob.js';

export class ImageData {
  constructor(a, b, c) {
    if (a instanceof globalThis.Uint8ClampedArray) {
      this.data   = a;
      this.width  = b | 0;
      this.height = (c | 0) || (this.data.length / 4 / this.width) | 0;
    } else {
      this.width  = a | 0;
      this.height = b | 0;
      this.data   = new globalThis.Uint8ClampedArray(this.width * this.height * 4);
    }
    this.colorSpace = 'srgb';
  }
}

// Decoded pixel buffer. Constructed via `createImageBitmap(blob)` or
// `OffscreenCanvas.transferToImageBitmap`.
export class ImageBitmap {
  constructor() {
    this.width   = 0;
    this.height  = 0;
    this._pixels = null;  // Uint8ClampedArray, RGBA row-major
  }
  close() { this._pixels = null; this.width = this.height = 0; }
}

// Walks an arg to `drawImage` and returns `{pixels, width, height}`
// for the source. HTMLImageElement / Image with a loaded blob URL
// populates `_pixels` on `src=` assignment; ImageBitmap already
// carries them; canvases expose their own backing buffer.
function resolveImagePixels(src) {
  if (!src) return null;
  if (src._pixels && src.width && src.height) return {pixels: src._pixels, width: src.width, height: src.height};
  // HTMLVideoElement's first-decoded frame is cached the same shape.
  const f = src._csimVideoFrame;
  if (f && f._pixels && f.width && f.height) return {pixels: f._pixels, width: f.width, height: f.height};
  return null;
}

// RGBA blit: copies `(sw × sh)` from `(sx, sy)` in `src` (`srcW × srcH`)
// to `(dx, dy)` in `dst` (`dstW × dstH`), scaling to `(dw × dh)` with
// nearest-neighbour. Same primitive serves drawImage, getImageData,
// and putImageData — the difference is just the src/dst geometry
// the caller passes.
//
// Identity blit (sw === dw && sh === dh && fully in-bounds) takes a
// per-row `TypedArray.set(subarray)` fast path that's 10-20× the
// per-pixel byte-loop on V8. Mixed-scale / clipped paths fall through
// to the loop.
function blitRGBA(src, srcW, srcH, sx, sy, sw, sh, dst, dstW, dstH, dx, dy, dw, dh) {
  const isIdentity  = (sw === dw) && (sh === dh);
  const allInBounds = sx >= 0 && sy >= 0 && sx + sw <= srcW && sy + sh <= srcH &&
                      dx >= 0 && dy >= 0 && dx + dw <= dstW && dy + dh <= dstH;
  if (isIdentity && allInBounds) {
    for (let row = 0; row < sh; row++) {
      const sRowStart = ((sy + row) * srcW + sx) * 4;
      const dRowStart = ((dy + row) * dstW + dx) * 4;
      dst.set(src.subarray(sRowStart, sRowStart + sw * 4), dRowStart);
    }
    return;
  }
  for (let row = 0; row < dh; row++) {
    const srcRow = sy + ((row * sh / dh) | 0);
    const dstRow = dy + row;
    if (dstRow < 0 || dstRow >= dstH || srcRow < 0 || srcRow >= srcH) continue;
    for (let col = 0; col < dw; col++) {
      const srcCol = sx + ((col * sw / dw) | 0);
      const dstCol = dx + col;
      if (dstCol < 0 || dstCol >= dstW || srcCol < 0 || srcCol >= srcW) continue;
      const sIdx = (srcRow * srcW + srcCol) * 4;
      const dIdx = (dstRow * dstW + dstCol) * 4;
      dst[dIdx]     = src[sIdx];
      dst[dIdx + 1] = src[sIdx + 1];
      dst[dIdx + 2] = src[sIdx + 2];
      dst[dIdx + 3] = src[sIdx + 3];
    }
  }
}

// `createImageBitmap(blob)` — async factory. Reads the blob bytes
// (host-backed or in-memory), pipes through libvips for decode,
// returns a Promise<ImageBitmap>. Options (resizeWidth /
// resizeHeight) thread through to vips for cheap downscale.
export function createImageBitmap(source, optionsOrSx, sy, sw, sh, opts) {
  let options = optionsOrSx;
  // The (source, sx, sy, sw, sh [, options]) overload uses the crop
  // form; not implemented yet (OCR path doesn't need it). Pull
  // options from the last arg if present.
  if (typeof optionsOrSx === 'number') options = opts || {};
  options = options || {};
  return new Promise((resolve, reject) => {
    let bytes = '';
    if (source instanceof globalThis.Blob) {
      bytes = blobBytes(source);
    } else if (source instanceof ImageData) {
      // Direct rebuild — no decode needed.
      const bm = new ImageBitmap();
      bm._pixels = new globalThis.Uint8ClampedArray(source.data);
      bm.width   = source.width;
      bm.height  = source.height;
      return resolve(bm);
    } else {
      return reject(new TypeError('createImageBitmap: unsupported source'));
    }
    if (!bytes) return reject(new Error('createImageBitmap: empty source'));
    const decoded = globalThis.__csim_decodeImage(globalThis.btoa(bytes), options.resizeWidth | 0, options.resizeHeight | 0);
    if (!decoded) return reject(new Error('createImageBitmap: decode failed'));
    const pixelBytes = fetchTransfer(decoded.refId) || fetchedToBytes(decoded.pixels);
    if (!pixelBytes) return reject(new Error('createImageBitmap: decode failed'));
    const bm = new ImageBitmap();
    bm._pixels = new globalThis.Uint8ClampedArray(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
    bm.width   = decoded.width  | 0;
    bm.height  = decoded.height | 0;
    resolve(bm);
  });
}

// Minimal 2D context — just enough for the canvas-as-pixel-buffer
// pattern OCR / image-processing libraries use. Drawing primitives
// (fillRect / strokeText / paths) are no-ops; libraries that
// actually need to rasterise vector content won't get correct
// output, but they don't crash either.
export class CanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas                   = canvas;
    this.fillStyle                = '#000000';
    this.strokeStyle              = '#000000';
    this.globalAlpha              = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled    = true;
    this.lineWidth                = 1;
    this.font                     = '10px sans-serif';
    this.textAlign                = 'start';
    this.textBaseline             = 'alphabetic';
  }
  // No-op vector primitives — present so libraries that build a
  // path and then `getImageData` don't crash.
  save() {} restore() {}
  scale() {} rotate() {} translate() {} transform() {} setTransform() {} resetTransform() {}
  beginPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {}
  quadraticCurveTo() {} arc() {} arcTo() {} rect() {} ellipse() {}
  fill() {} stroke() {} clip() {}
  fillRect() {} strokeRect() {} clearRect() {}
  fillText() {} strokeText() {}
  measureText(s) {
    return {
      width:                     String(s).length * 6,
      actualBoundingBoxLeft:     0,
      actualBoundingBoxRight:    0,
      actualBoundingBoxAscent:   8,
      actualBoundingBoxDescent:  2
    };
  }

  drawImage(source, ...args) {
    const src = resolveImagePixels(source);
    if (!src) return;
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    let dx = 0, dy = 0, dw = sw, dh = sh;
    if      (args.length === 2) { dx = args[0] | 0; dy = args[1] | 0; }
    else if (args.length === 4) { dx = args[0] | 0; dy = args[1] | 0; dw = args[2] | 0; dh = args[3] | 0; }
    else if (args.length === 8) { sx = args[0] | 0; sy = args[1] | 0; sw = args[2] | 0; sh = args[3] | 0;
                                  dx = args[4] | 0; dy = args[5] | 0; dw = args[6] | 0; dh = args[7] | 0; }
    const cw = this.canvas.width  | 0;
    const ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    blitRGBA(src.pixels, src.width, src.height, sx, sy, sw, sh,
             this.canvas._pixels, cw, ch, dx, dy, dw, dh);
  }

  getImageData(x, y, w, h) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    const cw  = this.canvas.width  | 0;
    const ch  = this.canvas.height | 0;
    const out = new globalThis.Uint8ClampedArray(w * h * 4);
    const src = this.canvas._pixels;
    if (src) blitRGBA(src, cw, ch, x, y, w, h, out, w, h, 0, 0, w, h);
    return new ImageData(out, w, h);
  }

  putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
    const cw = this.canvas.width  | 0;
    const ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    const iw  = imageData.width  | 0;
    const ih  = imageData.height | 0;
    const drX = (dirtyX == null) ? 0  : (dirtyX | 0);
    const drY = (dirtyY == null) ? 0  : (dirtyY | 0);
    const drW = (dirtyW == null) ? iw : (dirtyW | 0);
    const drH = (dirtyH == null) ? ih : (dirtyH | 0);
    blitRGBA(imageData.data, iw, ih, drX, drY, drW, drH,
             this.canvas._pixels, cw, ch, (dx | 0) + drX, (dy | 0) + drY, drW, drH);
  }

  createImageData(arg1, arg2) {
    if (arg1 instanceof ImageData) return new ImageData(arg1.width, arg1.height);
    return new ImageData(arg1 | 0, arg2 | 0);
  }
}

export class OffscreenCanvas {
  constructor(width, height) {
    this.width   = width  | 0;
    this.height  = height | 0;
    this._pixels = null;
    this._ctx    = null;
  }
  getContext(type) {
    if (type !== '2d' && type !== 'bitmaprenderer') return null;
    this._ctx = this._ctx || new CanvasRenderingContext2D(this);
    return this._ctx;
  }
  transferToImageBitmap() {
    const bm = new ImageBitmap();
    bm._pixels = this._pixels && new globalThis.Uint8ClampedArray(this._pixels);
    bm.width   = this.width;
    bm.height  = this.height;
    // Per spec, transferTo… resets the source.
    this._pixels = null;
    return bm;
  }
  convertToBlob(options) {
    return Promise.resolve(canvasEncodeBlob(this, options));
  }
  toBlob(callback, type, quality) {
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

// Pixels in → encoded PNG/JPEG/WebP Blob out via libvips. Both pixel
// buffer (in) and encoded bytes (out) ride the Ruby-side transfer
// registry to avoid an 8900×8900-RGBA-sized base64 round-trip in JS.
function canvasEncodeBlob(canvas, options) {
  const opts = options || {};
  const type = String(opts.type || 'image/png').toLowerCase();
  const quality = typeof opts.quality === 'number' ? Math.round(opts.quality * 100) : 90;
  if (!canvas._pixels || !canvas.width || !canvas.height) {
    return new globalThis.Blob([''], {type});
  }
  const inRef = stashTransfer(canvas._pixels);
  const result = (typeof globalThis.__csim_encodeImage === 'function')
    ? globalThis.__csim_encodeImage(inRef, canvas.width | 0, canvas.height | 0, type, quality)
    : null;
  const encoded = result && fetchTransfer(result.refId);
  if (!encoded) {
    return new globalThis.Blob([canvas._pixels], {type: 'application/octet-stream'});
  }
  return new globalThis.Blob([encoded], {type});
}

export function installCanvasToBlob(ElementCtor) {
  const proto = ElementCtor.prototype;
  if (proto._csimCanvasToBlobInstalled) return;
  proto._csimCanvasToBlobInstalled = true;
  proto.toBlob = function (callback, type, quality) {
    if (this._tag !== 'canvas') {
      const cb = typeof callback === 'function' ? callback : function () {};
      queueMicrotask(() => cb(null));
      return;
    }
    scheduleToBlob(this, callback, type, quality);
  };
}

globalThis.ImageData                = ImageData;
globalThis.ImageBitmap              = ImageBitmap;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.OffscreenCanvas          = OffscreenCanvas;
globalThis.createImageBitmap        = createImageBitmap;
