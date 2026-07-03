// Pixel buffer / Canvas surface — an offscreen RGBA bitmap with an imperative
// 2D drawing API, independent of document layout. Two paths feed the buffer:
//   - Image I/O: `createImageBitmap(blob) → drawImage → getImageData` (the
//     Tesseract.js / image-processing chain). Decoding outsources to libvips
//     through `__csim_decodeImage` (PNG / JPEG / WebP / GIF).
//   - Vector rasterization: solid-colour rectangle fills (`fillRect` /
//     `clearRect` / `strokeRect`) paint through the current transform directly
//     into the buffer, so a drawing UI's output shows up in `getImageData` /
//     `toDataURL`. Paths, gradients, and text are still no-ops (later stages) —
//     libraries that build them don't crash, they just get no output yet.

import { fetchedToBytes, fetchTransfer, stashTransfer } from './bytes.js';
import { blobBytes }                                                   from './blob.js';
import { SYSTEM_COLORS }                                               from './css-utils.js';

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

// --- 2D vector rasterization (fillRect / clearRect / strokeRect) ---------
//
// Axis-aligned and affine-transformed rectangle fills paint directly into the
// canvas backing buffer (`canvas._pixels`, RGBA row-major). Paths, gradients,
// and text are still no-ops (later stages); this is the solid-colour rect
// surface libraries and drawing UIs actually hit first.

// Parse a CSS colour to `{r, g, b, a}` (a in 0..1), or null when unparseable —
// an invalid `fillStyle` / `strokeStyle` assignment is ignored per spec. The
// `#rgb`-family hex forms are handled inline (cheap, and available during the
// snapshot build before `__csimVendor` is wired); everything else routes
// through culori's canonical `rgb()/rgba()` serialization.
function parseColorRGBA(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  let m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    const dup = c => parseInt(c + c, 16);
    const at  = (i, n) => parseInt(h.slice(i, i + n), 16);
    switch (h.length) {
      case 3: return {r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: 1};
      case 4: return {r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: dup(h[3]) / 255};
      case 6: return {r: at(0, 2), g: at(2, 2), b: at(4, 2), a: 1};
      case 8: return {r: at(0, 2), g: at(2, 2), b: at(4, 2), a: at(6, 2) / 255};
      default: return null;
    }
  }
  const vend = globalThis.__csimVendor && globalThis.__csimVendor.color;
  let canon = null;
  // culori throws on some malformed inputs; an invalid colour assignment must be
  // ignored (return null), never propagate out of the fillStyle/strokeStyle setter.
  if (vend && typeof vend.computed === 'function') {
    try { canon = vend.computed(s); } catch (_) { canon = null; }
  }
  if (!canon) {
    // CSS system colours (Canvas / ButtonFace / …) aren't <color>s culori parses;
    // map to their UA sRGB value and re-resolve, matching style-proxy's normalizeColor.
    const sys = SYSTEM_COLORS[s.toLowerCase()];
    return sys ? parseColorRGBA(sys) : null;
  }
  m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(canon);
  return m ? {r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4]} : null;
}

// True when every argument is a finite number (the geometry / transform methods
// no-op on a non-finite coordinate per the canvas spec). `isFinite` reads only
// its first argument, so `every`'s (element, index, array) callback is safe here.
function allFinite(...xs) { return xs.every(isFinite); }

// Clamp to the 0..1 alpha range.
function clamp01(a) { return a < 0 ? 0 : a > 1 ? 1 : a; }

// Ascending comparator for scanline edge-crossings by x (module-level so the
// sort doesn't allocate a fresh closure per row).
function crossCmp(a, b) { return a.x - b.x; }

// The canvas "serialize a colour": an opaque colour → lowercase `#rrggbb`,
// otherwise `rgba(r, g, b, a)` — what `ctx.fillStyle` reads back.
function serializeCanvasColor(c) {
  if (c.a >= 1) {
    const hx = n => n.toString(16).padStart(2, '0');
    return '#' + hx(c.r) + hx(c.g) + hx(c.b);
  }
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${+c.a.toFixed(3)})`;
}

// Source-over composite one colour over the pixel at byte offset `i`, at the
// given effective alpha (colour alpha × globalAlpha). Uint8ClampedArray rounds
// and clamps on store, so the premultiplied blend needs no manual clamping.
function blendPixel(buf, i, col, a) {
  if (a >= 1) { buf[i] = col.r; buf[i + 1] = col.g; buf[i + 2] = col.b; buf[i + 3] = 255; return; }
  const da   = buf[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
  const keep = da * (1 - a);
  buf[i]     = (col.r * a + buf[i]     * keep) / outA;
  buf[i + 1] = (col.g * a + buf[i + 1] * keep) / outA;
  buf[i + 2] = (col.b * a + buf[i + 2] * keep) / outA;
  buf[i + 3] = outA * 255;
}

// Invert a 2D affine matrix `[a, b, c, d, e, f]`, or null when singular — used to
// map a device pixel back to user space for gradient sampling.
function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !isFinite(det)) return null;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id,
          (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

// Linearly interpolate two parsed colours (straight RGBA, f in 0..1).
function lerpColor(a, b, f) {
  return {r: Math.round(a.r + (b.r - a.r) * f), g: Math.round(a.g + (b.g - a.g) * f),
          b: Math.round(a.b + (b.b - a.b) * f), a: a.a + (b.a - a.a) * f};
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
    let imgPixels;
    if (source instanceof globalThis.Blob) {
      bytes = blobBytes(source);
    } else if (source instanceof ImageData) {
      // Direct rebuild — no decode needed.
      const bm = new ImageBitmap();
      bm._pixels = new globalThis.Uint8ClampedArray(source.data);
      bm.width   = source.width;
      bm.height  = source.height;
      return resolve(bm);
    } else if (source instanceof ImageBitmap) {
      // Copy an existing bitmap's pixels (createImageBitmap(imageBitmap)).
      const bm = new ImageBitmap();
      bm._pixels = source._pixels ? new globalThis.Uint8ClampedArray(source._pixels) : null;
      bm.width   = source.width;
      bm.height  = source.height;
      return resolve(bm);
    } else if ((imgPixels = resolveImagePixels(source))) {
      // An image / video source exposes a backing pixel buffer (our 2D rasterizer paints into
      // it, the decoder fills it) — snapshot it into a bitmap.
      const bm = new ImageBitmap();
      bm._pixels = new globalThis.Uint8ClampedArray(imgPixels.pixels);
      bm.width   = imgPixels.width;
      bm.height  = imgPixels.height;
      return resolve(bm);
    } else if (isCanvasSource(source)) {
      // A <canvas> / OffscreenCanvas source: snapshot its backing buffer, zero-filled when
      // nothing has been drawn (an undrawn canvas is transparent black) — createImageBitmap(canvas).
      const w  = source.width | 0, h = source.height | 0;
      const bm = new ImageBitmap();
      bm.width   = w;
      bm.height  = h;
      bm._pixels = source._pixels ? new globalThis.Uint8ClampedArray(source._pixels)
                                  : new globalThis.Uint8ClampedArray(w * h * 4);
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

// A linear or radial gradient set as a fill/stroke style. Colour stops are kept
// sorted by offset (stable for equal offsets), and `_sampler()` returns a per-
// point colour function so fill/stroke can evaluate the gradient per pixel.
export class CanvasGradient {
  constructor(kind, coords) { this._kind = kind; this._c = coords; this._stops = []; }

  addColorStop(offset, color) {
    offset = +offset;
    if (!(offset >= 0 && offset <= 1)) throw new globalThis.DOMException('offset out of [0,1]', 'IndexSizeError');
    const col = parseColorRGBA(color);
    if (!col) throw new globalThis.DOMException('invalid color', 'SyntaxError');
    let i = this._stops.length;                       // insert keeping offsets sorted,
    while (i > 0 && this._stops[i - 1].offset > offset) i--;   // stable for equal offsets
    this._stops.splice(i, 0, {offset, color: col});
  }

  get [Symbol.toStringTag]() { return 'CanvasGradient'; }

  // Colour for gradient parameter t (0..1), interpolating between surrounding
  // stops and clamping to the end stops outside the range.
  _sample(t) {
    const s = this._stops;
    if (t <= s[0].offset) return s[0].color;
    const last = s[s.length - 1];
    if (t >= last.offset) return last.color;
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i].offset) {
        const p = s[i - 1], q = s[i];
        return lerpColor(p.color, q.color, (t - p.offset) / ((q.offset - p.offset) || 1));
      }
    }
    return last.color;
  }

  // Return a sampler `(ux, uy) => colour|null` for a user-space point, with the
  // gradient-invariant constants hoisted out of the per-pixel loop. Returns a
  // constant-null sampler where the gradient paints nothing (no stops, or a
  // degenerate linear gradient).
  _sampler() {
    if (this._stops.length === 0) return () => null;
    const c = this._c;
    if (this._kind === 'linear') {
      const x0 = c.x0, y0 = c.y0, dx = c.x1 - x0, dy = c.y1 - y0, len2 = dx * dx + dy * dy;
      if (len2 === 0) return () => null;              // zero-length: nothing painted (spec)
      return (ux, uy) => this._sample(((ux - x0) * dx + (uy - y0) * dy) / len2);
    }
    // Radial: for each point find the largest parameter ω placing it on the
    // interpolated circle (centre + radius both lerp from stop 0 to stop 1) with
    // radius ≥ 0. A = dcx²+dcy²−dr² is gradient-invariant; B, C are per-point.
    const x0 = c.x0, y0 = c.y0, r0 = c.r0;
    const dcx = c.x1 - x0, dcy = c.y1 - y0, dr = c.r1 - r0;
    const A = dcx * dcx + dcy * dcy - dr * dr;
    return (ux, uy) => {
      const px = ux - x0, py = uy - y0;
      const B = 2 * (px * dcx + py * dcy + r0 * dr);
      const C = px * px + py * py - r0 * r0;
      let omega;
      if (Math.abs(A) < 1e-9) {
        if (B === 0) return null;
        omega = C / B;
        if (r0 + omega * dr < 0) return null;
      } else {
        const disc = B * B - 4 * A * C;
        if (disc < 0) return null;
        const sq = Math.sqrt(disc), hi = Math.max((B + sq) / (2 * A), (B - sq) / (2 * A)),
              lo = Math.min((B + sq) / (2 * A), (B - sq) / (2 * A));
        if (r0 + hi * dr >= 0) omega = hi;
        else if (r0 + lo * dr >= 0) omega = lo;
        else return null;
      }
      return this._sample(omega);
    };
  }
}

// 2D rendering context: image blit + readback (drawImage / getImageData /
// putImageData) plus rectangle + arbitrary-path rasterization (fill / stroke /
// clip) through the current transform, with solid-colour and gradient paints.
// Patterns and text remain unimplemented (later stages) — present where needed
// so libraries that build them don't crash; they produce no output yet.
export class CanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this._resetState();
  }

  // Reset the full rendering state to defaults. Called at construction and when
  // the canvas is resized (setting width/height resets the context per spec):
  // transform, clip, styles, line params, and the current path all go back to
  // their initial values.
  _resetState() {
    this.globalAlpha              = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled    = true;
    this.lineWidth                = 1;
    this.lineCap                  = 'butt';
    this.lineJoin                 = 'miter';
    this.miterLimit               = 10;
    this.font                     = '10px sans-serif';
    this.textAlign                = 'start';
    this.textBaseline             = 'alphabetic';
    this._fill                    = {r: 0, g: 0, b: 0, a: 1};   // parsed fillStyle (solid)
    this._stroke                  = {r: 0, g: 0, b: 0, a: 1};   // parsed strokeStyle (solid)
    this._fillObj                 = null;                        // gradient fillStyle, if set
    this._strokeObj               = null;                        // gradient strokeStyle, if set
    this._clip                    = null;                        // clip mask (Uint8Array) or null
    this._lineDash                = [];
    this._m                       = [1, 0, 0, 1, 0, 0];         // current transform
    this._stack                   = [];                          // save()/restore() state
    this._path                    = [];                          // subpaths: {pts:[[x,y]…], closed}
    this._sub                     = null;                        // current subpath
    this._hasPoint                = false;                       // is there a current point?
    this._cx = this._cy = 0;                                     // current point
    this._sx = this._sy = 0;                                     // current subpath start (for closePath)
  }

  // fillStyle / strokeStyle: a CanvasGradient is stored and read back as the
  // object; a valid CSS colour is stored parsed + read back in the canvas
  // serialization; an invalid string is ignored (spec's "otherwise, do nothing").
  get fillStyle() { return this._fillObj || serializeCanvasColor(this._fill); }
  set fillStyle(v) {
    if (v instanceof CanvasGradient) { this._fillObj = v; return; }
    const c = parseColorRGBA(v); if (c) { this._fill = c; this._fillObj = null; }
  }
  get strokeStyle() { return this._strokeObj || serializeCanvasColor(this._stroke); }
  set strokeStyle(v) {
    if (v instanceof CanvasGradient) { this._strokeObj = v; return; }
    const c = parseColorRGBA(v); if (c) { this._stroke = c; this._strokeObj = null; }
  }

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

  // Drawing-state stack. save() snapshots the transform + the state fields the
  // vector surface reads; restore() pops the most recent (a no-op when empty).
  // The current path is NOT part of the drawing state — it persists across
  // save/restore, per spec.
  save() {
    this._stack.push({
      m: this._m.slice(), fill: this._fill, stroke: this._stroke,
      fillObj: this._fillObj, strokeObj: this._strokeObj, clip: this._clip,
      globalAlpha: this.globalAlpha, lineWidth: this.lineWidth,
      lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit,
      lineDash: this._lineDash,
      globalCompositeOperation: this.globalCompositeOperation,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
    });
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._m = s.m; this._fill = s.fill; this._stroke = s.stroke;
    this._fillObj = s.fillObj; this._strokeObj = s.strokeObj; this._clip = s.clip;
    this.globalAlpha = s.globalAlpha; this.lineWidth = s.lineWidth;
    this.lineCap = s.lineCap; this.lineJoin = s.lineJoin; this.miterLimit = s.miterLimit;
    this._lineDash = s.lineDash;
    this.globalCompositeOperation = s.globalCompositeOperation;
    this.imageSmoothingEnabled = s.imageSmoothingEnabled;
    this.font = s.font; this.textAlign = s.textAlign; this.textBaseline = s.textBaseline;
  }
  setLineDash(segments) { this._lineDash = Array.isArray(segments) ? segments.slice() : []; }
  getLineDash() { return this._lineDash.slice(); }

  // Transform stack. Each mutates the current transform matrix (CTM); rect fills
  // map their corners through it, so translate / scale / rotate all take effect.
  // Per spec every transform method is a no-op when any argument is non-finite
  // (NaN / ±Infinity) — the prior matrix is preserved rather than poisoned.
  translate(x, y) { if (allFinite(x = +x, y = +y)) this._m = mulMatrix(this._m, [1, 0, 0, 1, x, y]); }
  scale(x, y)     { if (allFinite(x = +x, y = +y)) this._m = mulMatrix(this._m, [x, 0, 0, y, 0, 0]); }
  rotate(rad) {
    if (!allFinite(rad = +rad)) return;
    const c = Math.cos(rad), s = Math.sin(rad);
    this._m = mulMatrix(this._m, [c, s, -s, c, 0, 0]);
  }
  transform(a, b, c, d, e, f) {
    if (allFinite(a = +a, b = +b, c = +c, d = +d, e = +e, f = +f)) this._m = mulMatrix(this._m, [a, b, c, d, e, f]);
  }
  setTransform(a, b, c, d, e, f) {
    if (allFinite(a = +a, b = +b, c = +c, d = +d, e = +e, f = +f)) this._m = [a, b, c, d, e, f];
  }
  resetTransform() { this._m = [1, 0, 0, 1, 0, 0]; }

  // ── Path building ───────────────────────────────────────────────────────
  // The current path is a list of subpaths, each an array of user-space points
  // (curves/arcs are flattened to line segments on the way in). fill() / stroke()
  // map the points through the CTM at paint time.
  beginPath() { this._path = []; this._sub = null; this._hasPoint = false; }

  // Start a new subpath at (x, y) and make it the current point.
  _moveToPoint(x, y) {
    this._sub = {pts: [[x, y]], closed: false};
    this._path.push(this._sub);
    this._cx = this._sx = x; this._cy = this._sy = y;
    this._hasPoint = true;
  }

  // The spec's "ensure there is a subpath for (x, y)": when there is no current
  // point, seed one at (x, y) (the first control point for the curve methods).
  _ensurePoint(x, y) { if (!this._hasPoint) this._moveToPoint(x, y); }

  moveTo(x, y) { if (allFinite(x = +x, y = +y)) this._moveToPoint(x, y); }

  lineTo(x, y) {
    if (!allFinite(x = +x, y = +y)) return;
    if (!this._hasPoint) { this._moveToPoint(x, y); return; }   // first lineTo acts as moveTo
    this._sub.pts.push([x, y]); this._cx = x; this._cy = y;
  }

  closePath() {
    if (!this._sub || this._sub.pts.length === 0) return;
    this._sub.closed = true;
    // A new subpath begins at the closed subpath's start point.
    this._moveToPoint(this._sx, this._sy);
  }

  rect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    this._path.push({pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true});
    this._moveToPoint(x, y);   // rect() leaves a fresh subpath at (x, y)
  }

  // Average scale of the CTM, used to pick a curve/arc flattening resolution that
  // stays smooth in device pixels regardless of the transform.
  _ctmScale() {
    const m = this._m;
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) || 1;
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!allFinite(c1x = +c1x, c1y = +c1y, c2x = +c2x, c2y = +c2y, x = +x, y = +y)) return;
    this._ensurePoint(c1x, c1y);   // spec: seed a subpath at the first control point
    const x0 = this._cx, y0 = this._cy, sub = this._sub;
    const n = Math.min(256, Math.max(8, Math.ceil(this._ctmScale() *
      (Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y)) / 8)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      sub.pts.push([a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y]);
    }
    this._cx = x; this._cy = y;
  }

  quadraticCurveTo(cx, cy, x, y) {
    if (!allFinite(cx = +cx, cy = +cy, x = +x, y = +y)) return;
    this._ensurePoint(cx, cy);     // spec: seed a subpath at the control point
    const x0 = this._cx, y0 = this._cy, sub = this._sub;
    const n = Math.min(256, Math.max(8, Math.ceil(this._ctmScale() *
      (Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy)) / 8)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      sub.pts.push([u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y]);
    }
    this._cx = x; this._cy = y;
  }

  arc(cx, cy, r, a0, a1, ccw) {
    if (!allFinite(cx = +cx, cy = +cy, r = +r, a0 = +a0, a1 = +a1) || r < 0) return;
    this._arcImpl(cx, cy, r, r, 0, a0, a1, !!ccw);
  }

  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
    if (!allFinite(cx = +cx, cy = +cy, rx = +rx, ry = +ry, rot = +rot, a0 = +a0, a1 = +a1) || rx < 0 || ry < 0) return;
    this._arcImpl(cx, cy, rx, ry, rot, a0, a1, !!ccw);
  }

  // Flatten an (optionally rotated) elliptical arc into line segments appended to
  // the current subpath. The connecting edge from the current point to the arc
  // start is created implicitly by the first pushed point.
  _arcImpl(cx, cy, rx, ry, rot, a0, a1, ccw) {
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const pointAt = t => {
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      return [cx + ex * cosR - ey * sinR, cy + ex * sinR + ey * cosR];
    };
    // With no current point the arc start seeds the subpath (moveTo); otherwise
    // the first pushed point forms the connecting line from the current point.
    const start = pointAt(a0);
    if (!this._hasPoint) this._moveToPoint(start[0], start[1]);
    const sub = this._sub;
    const TAU = 2 * Math.PI;
    let delta;
    if (!ccw) { delta = a1 - a0 >= TAU ? TAU : ((a1 - a0) % TAU + TAU) % TAU; }
    else      { delta = a0 - a1 >= TAU ? -TAU : -(((a0 - a1) % TAU + TAU) % TAU); }
    const maxR = Math.max(rx, ry) * this._ctmScale();
    const n = Math.min(2048, Math.max(6, Math.ceil(Math.abs(delta) / TAU * Math.max(12, maxR))));
    for (let i = 0; i <= n; i++) sub.pts.push(pointAt(a0 + delta * (i / n)));
    const end = pointAt(a0 + delta);
    this._cx = end[0]; this._cy = end[1]; this._hasPoint = true;
  }

  arcTo(x1, y1, x2, y2, r) {
    if (!allFinite(x1 = +x1, y1 = +y1, x2 = +x2, y2 = +y2, r = +r) || r < 0) return;
    this._ensurePoint(x1, y1);   // spec: seed a subpath at (x1, y1) when the path is empty
    const x0 = this._cx, y0 = this._cy;
    const d01x = x0 - x1, d01y = y0 - y1, d21x = x2 - x1, d21y = y2 - y1;
    const l01 = Math.hypot(d01x, d01y), l21 = Math.hypot(d21x, d21y);
    // Degenerate cases (coincident points / collinear / zero radius) reduce to a
    // straight line to the corner (x1, y1), matching the spec.
    if (l01 === 0 || l21 === 0 || r === 0 || d01x * d21y - d01y * d21x === 0) { this.lineTo(x1, y1); return; }
    // Half-angle at the corner → tangent-point distance along each edge, and the
    // arc centre distance along the corner's bisector.
    const angle = Math.acos(Math.max(-1, Math.min(1, (d01x * d21x + d01y * d21y) / (l01 * l21))));
    const tan = r / Math.tan(angle / 2);
    const t0x = x1 + d01x / l01 * tan, t0y = y1 + d01y / l01 * tan;   // tangent on incoming edge
    const t2x = x1 + d21x / l21 * tan, t2y = y1 + d21y / l21 * tan;   // tangent on outgoing edge
    let bx = d01x / l01 + d21x / l21, by = d01y / l01 + d21y / l21;
    const bl = Math.hypot(bx, by) || 1;
    const dc = r / Math.sin(angle / 2);
    const cxC = x1 + bx / bl * dc, cyC = y1 + by / bl * dc;
    this.lineTo(t0x, t0y);
    // Sweep the short way (the tangent arc is always < π) between the two tangent
    // points around the centre.
    const a0 = Math.atan2(t0y - cyC, t0x - cxC);
    let delta = Math.atan2(t2y - cyC, t2x - cxC) - a0;
    while (delta > Math.PI)  delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    this._arcImpl(cxC, cyC, r, r, 0, a0, a0 + delta, delta < 0);
    this._cx = t2x; this._cy = t2y;
  }

  // ── Path → device-space geometry ─────────────────────────────────────────
  // Map every subpath (≥2 points) through the CTM to device-space rings.
  _devicePath() {
    const m = this._m, rings = [];
    for (const sub of this._path) {
      if (sub.pts.length < 2) continue;
      const ring = [];
      for (const p of sub.pts) ring.push([m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]);
      rings.push(ring);
    }
    return rings;
  }

  // Build a device-space quad ring per path segment, offset by half the (user-
  // space) line width so the stroke scales with the CTM.
  _strokeRings(lw) {
    const m = this._m, half = lw / 2, rings = [];
    const tx = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    for (const sub of this._path) {
      const pts = sub.pts, n = pts.length;
      if (n < 2) continue;
      const segCount = sub.closed ? n : n - 1;
      for (let i = 0; i < segCount; i++) {
        const p1 = pts[i], p2 = pts[i + 1 === n ? 0 : i + 1];
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const nx = -dy / len * half, ny = dx / len * half;   // user-space perpendicular
        rings.push([tx(p1[0] + nx, p1[1] + ny), tx(p2[0] + nx, p2[1] + ny),
                    tx(p2[0] - nx, p2[1] - ny), tx(p1[0] - nx, p1[1] - ny)]);
      }
    }
    return rings;
  }

  // Map a user-space rect's 4 corners through the CTM to device-space points.
  _rectCorners(x, y, w, h) {
    const m = this._m;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) =>
      [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]);
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

  // ── Coverage: enumerate covered device pixels, calling emit(px, py) ────────
  // The enumerators only decide coverage; the caller's emit composites (or, for
  // clip(), records a mask), keeping gradients and the clip mask orthogonal.

  // Axis-aligned device box (pixel-centre coverage: an integer-aligned rect fills
  // an exact block). The fast path for the common untransformed / scale-only CTM.
  _enumBox(x0, y0, x1, y1, emit) {
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const xL = Math.max(0, Math.ceil(x0 - 0.5)), xR = Math.min(cw - 1, Math.floor(x1 - 0.5));
    const yT = Math.max(0, Math.ceil(y0 - 0.5)), yB = Math.min(ch - 1, Math.floor(y1 - 0.5));
    for (let py = yT; py <= yB; py++) for (let px = xL; px <= xR; px++) emit(px, py);
  }

  // Scanline coverage of device-space polygon rings under a winding rule. Each
  // ring is implicitly closed; every edge crossing at the pixel-centre scanline
  // records its x and vertical direction. 'nonzero' emits one span per contiguous
  // non-zero-winding region (so overlapping stroke quads at a join are covered
  // once); 'evenodd' emits alternate spans (the strokeRect outer-minus-inner frame).
  _enumScanline(rings, rule, emit) {
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    let minY = Infinity, maxY = -Infinity;
    for (const ring of rings) for (const p of ring) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (!isFinite(minY)) return;
    const yStart = Math.max(0, Math.ceil(minY - 0.5));
    const yEnd   = Math.min(ch - 1, Math.floor(maxY - 0.5));
    const evenOdd = rule === 'evenodd';
    const xs = [];
    for (let py = yStart; py <= yEnd; py++) {
      const sy = py + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        const rn = ring.length;
        for (let i = 0; i < rn; i++) {
          const p1 = ring[i], p2 = ring[i + 1 === rn ? 0 : i + 1];
          const y1 = p1[1], y2 = p2[1];
          if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) {
            xs.push({x: p1[0] + (sy - y1) / (y2 - y1) * (p2[0] - p1[0]), dir: y2 > y1 ? 1 : -1});
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort(crossCmp);
      if (evenOdd) {
        for (let k = 0; k + 1 < xs.length; k += 2) this._emitSpan(emit, py, cw, xs[k].x, xs[k + 1].x);
      } else {
        let w = 0, spanStart = 0;
        for (let k = 0; k < xs.length; k++) {
          const prev = w;
          w += xs[k].dir;
          if (prev === 0 && w !== 0) spanStart = xs[k].x;
          else if (prev !== 0 && w === 0) this._emitSpan(emit, py, cw, spanStart, xs[k].x);
        }
      }
    }
  }

  // Emit the covered device pixels of one scanline span [xa, xb) (pixel-centre).
  _emitSpan(emit, py, cw, xa, xb) {
    const xL = Math.max(0, Math.ceil(xa - 0.5));
    const xR = Math.min(cw - 1, Math.floor(xb - 0.5));
    for (let px = xL; px <= xR; px++) emit(px, py);
  }

  // Coverage of the user-space rect through the CTM: fast box when axis-aligned,
  // scanline polygon otherwise.
  _enumRect(x, y, w, h, emit) {
    if (this._axisAligned()) {
      const m = this._m;
      this._enumBox(m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5], emit);
    } else {
      this._enumScanline([this._rectCorners(x, y, w, h)], 'nonzero', emit);
    }
  }

  // ── Compositing ─────────────────────────────────────────────────────────
  // Resolve a fill/stroke style (gradient object or solid colour) to a per-pixel
  // painter `(buf, i, px, py) => void`, or null when it paints nothing (a fully
  // transparent solid, or a singular CTM for a gradient).
  _painter(obj, solid) {
    const ga = this.globalAlpha;
    if (obj instanceof CanvasGradient) {
      const inv = invertMatrix(this._m);
      if (!inv) return null;
      const sample = obj._sampler();
      return (buf, i, px, py) => {
        const dx = px + 0.5, dy = py + 0.5;
        const c = sample(inv[0] * dx + inv[2] * dy + inv[4], inv[1] * dx + inv[3] * dy + inv[5]);
        if (c) blendPixel(buf, i, c, clamp01(c.a * ga));
      };
    }
    const a = clamp01(solid.a * ga);
    if (a <= 0) return null;
    return (buf, i) => blendPixel(buf, i, solid, a);
  }

  // Run an enumerator (which calls emit(px, py) per covered device pixel),
  // compositing `painter` at each pixel that passes the clip mask.
  _paintWith(painter, enumerate) {
    const buf = this._buffer();
    if (!buf || !painter) return;
    const cw = this.canvas.width | 0, clip = this._clip;
    enumerate((px, py) => {
      const idx = py * cw + px;
      if (clip && !clip[idx]) return;
      painter(buf, idx * 4, px, py);
    });
  }

  // fill(): rasterize the current path (subpaths implicitly closed) under the
  // winding rule ('nonzero' default, or 'evenodd'). A Path2D first arg isn't
  // supported yet — the rule may still be read from either position.
  fill(a, b) {
    const rule = a === 'evenodd' || b === 'evenodd' ? 'evenodd' : 'nonzero';
    const rings = this._devicePath();
    if (rings.length) this._paintWith(this._painter(this._fillObj, this._fill),
                                      emit => this._enumScanline(rings, rule, emit));
  }

  // stroke(): thicken each segment into a device-space quad and paint the whole
  // set in one nonzero pass — the union covers overlaps (joins) exactly once, so a
  // translucent strokeStyle doesn't darken at corners. Butt caps / bevel-ish
  // joins (lineCap / lineJoin / dashes are stored but not yet honored).
  stroke() {
    const rings = this._strokeRings(this.lineWidth > 0 ? this.lineWidth : 1);
    if (rings.length) this._paintWith(this._painter(this._strokeObj, this._stroke),
                                      emit => this._enumScanline(rings, 'nonzero', emit));
  }

  // clip(): intersect the clip region with the current path (default 'nonzero',
  // or 'evenodd'), so subsequent fills/strokes are masked. Part of the drawing
  // state (save/restore'd); clip() only ever shrinks the region.
  clip(a, b) {
    const rule = a === 'evenodd' || b === 'evenodd' ? 'evenodd' : 'nonzero';
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    const mask = new globalThis.Uint8Array(cw * ch);
    this._enumScanline(this._devicePath(), rule, (px, py) => { mask[py * cw + px] = 1; });
    if (this._clip) { const old = this._clip; for (let k = 0; k < mask.length; k++) mask[k] &= old[k]; }
    this._clip = mask;
  }

  fillText() {} strokeText() {}

  fillRect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    this._paintWith(this._painter(this._fillObj, this._fill), emit => this._enumRect(x, y, w, h, emit));
  }

  clearRect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    // clearRect ignores fillStyle / globalAlpha — it zeroes covered pixels (still
    // honoring the clip mask), so it uses a dedicated clearing painter.
    this._paintWith((buf, i) => { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; },
                    emit => this._enumRect(x, y, w, h, emit));
  }

  // strokeRect paints the rectangle's border centred on the path edge (half the
  // line width inside, half outside). The border is an outer rect minus a
  // concentric inner rect, painted as two rings under the even-odd rule — a single
  // pass, so overlaps never double-composite under a translucent strokeStyle, and
  // it composes through the CTM (the stroke scales / rotates with the transform).
  strokeRect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || (!w && !h)) return;
    if (w < 0) { x += w; w = -w; }               // normalize so the outer/inner
    if (h < 0) { y += h; h = -h; }               // half-width expansion is signed right
    const lw = this.lineWidth > 0 ? this.lineWidth : 1;
    const half = lw / 2;
    const rings = [this._rectCorners(x - half, y - half, w + lw, h + lw)];
    // A hole exists only when the stroke doesn't span the whole rect; otherwise
    // the thick border fills it entirely (a single outer ring).
    if (w > lw && h > lw) rings.push(this._rectCorners(x + half, y + half, w - lw, h - lw));
    this._paintWith(this._painter(this._strokeObj, this._stroke),
                    emit => this._enumScanline(rings, 'evenodd', emit));
  }

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
  return 'data:' + mime + ';base64,' + globalThis.btoa(blobBytes(blob));
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
    scheduleToBlob(this, callback, type, quality);
  };
  proto.toDataURL = function (type, quality) {
    if (this._tag !== 'canvas') return 'data:,';
    return canvasToDataURL(this, type, quality);
  };
}

globalThis.ImageData                = ImageData;
globalThis.ImageBitmap              = ImageBitmap;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.CanvasGradient           = CanvasGradient;
globalThis.OffscreenCanvas          = OffscreenCanvas;
globalThis.createImageBitmap        = createImageBitmap;
