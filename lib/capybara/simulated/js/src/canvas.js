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
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
];

// Separable box blur of a Float32 alpha plane (values 0..1), 3 passes to
// approximate a Gaussian — used for canvas shadows. Returns a blurred copy.
function boxBlurAlpha(src, w, h, radius) {
  if (!Number.isFinite(radius) || radius <= 0) return src;   // guard against Inf/NaN (would loop/corrupt)
  let a = src, b = new globalThis.Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    boxBlur1D(a, b, w, h, radius, true);  [a, b] = [b, a];   // horizontal
    boxBlur1D(a, b, w, h, radius, false); [a, b] = [b, a];   // vertical
  }
  return a;
}

// One separable box-blur pass (sliding window, O(w·h)); `horiz` picks the axis.
function boxBlur1D(src, dst, w, h, radius, horiz) {
  const win = radius * 2 + 1;
  const lines = horiz ? h : w, len = horiz ? w : h;
  const step = horiz ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const base = horiz ? line * w : line;
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += src[base + step * Math.min(len - 1, Math.max(0, i))];
    for (let i = 0; i < len; i++) {
      dst[base + step * i] = sum / win;
      const add = src[base + step * Math.min(len - 1, i + radius + 1)];
      const sub = src[base + step * Math.max(0, i - radius)];
      sum += add - sub;
    }
  }
}

// Accumulate a horizontal span [xa, xb) at weight `w` into a per-pixel coverage
// row — analytic X coverage, so boundary pixels get their fractional overlap.
// Returns true (and reports the touched pixel range in the module-level
// `spanRange` scratch, to avoid a per-span allocation in the raster loop) or
// false for an empty/off-canvas span.
const spanRange = [0, 0];
function addSpanCoverage(cov, xa, xb, w, cw) {
  if (xa < 0) xa = 0;
  if (xb > cw) xb = cw;
  if (xb <= xa) return false;
  const first = Math.floor(xa), last = Math.ceil(xb) - 1;
  for (let px = first; px <= last; px++) {
    const l = xa > px ? xa : px, r = xb < px + 1 ? xb : px + 1;
    if (r > l) cov[px] += (r - l) * w;
  }
  spanRange[0] = first; spanRange[1] = last;
  return true;
}

// Distance from point (px, py) to the segment p1→p2.
function distToSeg(px, py, p1, p2) {
  const vx = p2[0] - p1[0], vy = p2[1] - p1[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - p1[0]) * vx + (py - p1[1]) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (p1[0] + t * vx), py - (p1[1] + t * vy));
}

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

// Separable blend functions B(Cb, Cs) on straight 0..1 channels (W3C Compositing).
const BLEND = {
  multiply:      (b, s) => b * s,
  screen:        (b, s) => b + s - b * s,
  overlay:       (b, s) => b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
  darken:        (b, s) => Math.min(b, s),
  lighten:       (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)),
  'color-burn':  (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
  'hard-light':  (b, s) => s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b),
  'soft-light':  (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference:    (b, s) => Math.abs(b - s),
  exclusion:     (b, s) => b + s - 2 * b * s,
};

// Every valid globalCompositeOperation value (the setter ignores anything else).
// Only the per-covered-pixel operators are actually applied; the ones that also
// clear UNCOVERED destination (source-in/out, destination-in/atop, copy) and the
// non-separable blend modes (hue/saturation/color/luminosity) need a whole-canvas
// pass we don't do, and fall back to source-over.
const KNOWN_GCO = new globalThis.Set([
  'source-over', 'source-in', 'source-out', 'source-atop',
  'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'copy', 'xor', 'lighter', 'plus-lighter',
  ...Object.keys(BLEND), 'hue', 'saturation', 'color', 'luminosity',
]);

// Composite source colour `col` at alpha `a` onto the pixel at byte offset `i`
// under compositing operator `op`. Straight (non-premultiplied) alpha; the
// premultiplied result is divided back out for storage (Uint8ClampedArray clamps).
function compositePixel(buf, i, col, a, op) {
  if (op === 'source-over') { blendPixel(buf, i, col, a); return; }
  const as = a, ab = buf[i + 3] / 255;
  const sr = col.r / 255, sg = col.g / 255, sb = col.b / 255;
  const dr = buf[i] / 255, dg = buf[i + 1] / 255, db = buf[i + 2] / 255;
  let ao, pr, pg, pb;                       // out alpha + premultiplied out colour
  const blend = BLEND[op];
  if (blend) {
    ao = as + ab * (1 - as);
    // Blend-then-source-over, premultiplied. Coefficients hoisted out of the
    // per-channel math so the per-pixel hot path allocates nothing.
    const c0 = (1 - ab) * as, c1 = (1 - as) * ab, c2 = as * ab;
    pr = c0 * sr + c1 * dr + c2 * blend(dr, sr);
    pg = c0 * sg + c1 * dg + c2 * blend(dg, sg);
    pb = c0 * sb + c1 * db + c2 * blend(db, sb);
  } else if (op === 'lighter' || op === 'plus-lighter') {
    ao = Math.min(1, as + ab);
    pr = as * sr + ab * dr; pg = as * sg + ab * dg; pb = as * sb + ab * db;
  } else {
    let Fa, Fb;
    switch (op) {                           // Porter-Duff; whole-canvas ops fall to source-over
      case 'destination-over': Fa = 1 - ab; Fb = 1;      break;
      case 'destination-out':  Fa = 0;      Fb = 1 - as; break;
      case 'source-atop':      Fa = ab;     Fb = 1 - as; break;
      case 'xor':              Fa = 1 - ab; Fb = 1 - as; break;
      default:                 Fa = 1;      Fb = 1 - as; break;
    }
    ao = as * Fa + ab * Fb;
    pr = as * Fa * sr + ab * Fb * dr; pg = as * Fa * sg + ab * Fb * dg; pb = as * Fa * sb + ab * Fb * db;
  }
  if (ao <= 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
  buf[i] = pr / ao * 255; buf[i + 1] = pg / ao * 255; buf[i + 2] = pb / ao * 255; buf[i + 3] = ao * 255;
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
    if (this._kind === 'conic') {
      const TAU = 2 * Math.PI, a0 = c.a0, cx = c.x, cy = c.y;
      return (ux, uy) => {
        let ang = (Math.atan2(uy - cy, ux - cx) - a0) % TAU;   // clockwise from startAngle
        if (ang < 0) ang += TAU;
        return this._sample(ang / TAU);
      };
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

// The path-building surface (the CanvasPath IDL mixin) shared by the context's
// current default path and by Path2D. Subpaths are arrays of user-space points;
// curves and arcs are flattened on the way in at a resolution from `_scale()` —
// the owning context's CTM scale, or 1 for a standalone Path2D.
export class CanvasPath {
  constructor(scaleFn) { this._scaleFn = scaleFn || (() => 1); this.reset(); }
  reset() {
    this._path = []; this._sub = null; this._hasPoint = false;
    this._cx = this._cy = this._sx = this._sy = 0;
  }
  _scale() { return this._scaleFn() || 1; }

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
    this._moveToPoint(this._sx, this._sy);   // a new subpath begins at the start point
  }

  rect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    this._path.push({pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true});
    this._moveToPoint(x, y);   // rect() leaves a fresh subpath at (x, y)
  }

  // roundRect(x, y, w, h, radii): a rectangle with rounded corners. `radii` is a
  // number, an {x,y} radius, or a 1–4 list of those (CSS corner order:
  // top-left, top-right, bottom-right, bottom-left, with the usual 1/2/3-value
  // shorthands). Radii are clamped so opposite corners don't overlap.
  roundRect(x, y, w, h, radii = 0) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    const list = Array.isArray(radii) ? radii : [radii];
    if (list.length < 1 || list.length > 4) throw new globalThis.RangeError('roundRect: 1–4 radii');
    let nonFinite = false;
    const norm = v => {
      const rx = v && typeof v === 'object' ? +v.x : +v;
      const ry = v && typeof v === 'object' ? +v.y : +v;
      if (rx < 0 || ry < 0) throw new globalThis.RangeError('roundRect: negative radius');
      if (!isFinite(rx) || !isFinite(ry)) nonFinite = true;
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
    // swap radii to match, so the rounding follows the visual rectangle.
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
    this.closePath();
    this._moveToPoint(x, y);   // like rect(), leave a fresh subpath at (x, y)
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!allFinite(c1x = +c1x, c1y = +c1y, c2x = +c2x, c2y = +c2y, x = +x, y = +y)) return;
    this._ensurePoint(c1x, c1y);   // spec: seed a subpath at the first control point
    const x0 = this._cx, y0 = this._cy, sub = this._sub;
    const n = Math.min(256, Math.max(8, Math.ceil(this._scale() *
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
    const n = Math.min(256, Math.max(8, Math.ceil(this._scale() *
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
    const start = pointAt(a0);
    if (!this._hasPoint) this._moveToPoint(start[0], start[1]);
    const sub = this._sub;
    const TAU = 2 * Math.PI;
    let delta;
    if (!ccw) { delta = a1 - a0 >= TAU ? TAU : ((a1 - a0) % TAU + TAU) % TAU; }
    else      { delta = a0 - a1 >= TAU ? -TAU : -(((a0 - a1) % TAU + TAU) % TAU); }
    const maxR = Math.max(rx, ry) * this._scale();
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
    // Degenerate cases reduce to a straight line to the corner (x1, y1), per spec.
    if (l01 === 0 || l21 === 0 || r === 0 || d01x * d21y - d01y * d21x === 0) { this.lineTo(x1, y1); return; }
    const angle = Math.acos(Math.max(-1, Math.min(1, (d01x * d21x + d01y * d21y) / (l01 * l21))));
    const tan = r / Math.tan(angle / 2);
    const t0x = x1 + d01x / l01 * tan, t0y = y1 + d01y / l01 * tan;   // tangent on incoming edge
    const t2x = x1 + d21x / l21 * tan, t2y = y1 + d21y / l21 * tan;   // tangent on outgoing edge
    let bx = d01x / l01 + d21x / l21, by = d01y / l01 + d21y / l21;
    const bl = Math.hypot(bx, by) || 1;
    const dc = r / Math.sin(angle / 2);
    const cxC = x1 + bx / bl * dc, cyC = y1 + by / bl * dc;
    this.lineTo(t0x, t0y);
    const a0 = Math.atan2(t0y - cyC, t0x - cxC);   // sweep the short way (< π)
    let delta = Math.atan2(t2y - cyC, t2x - cxC) - a0;
    while (delta > Math.PI)  delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    this._arcImpl(cxC, cyC, r, r, 0, a0, a0 + delta, delta < 0);
    this._cx = t2x; this._cy = t2y;
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
    const t = transform;
    const val = (k, alias, dflt) => t[k] != null ? +t[k] : t[alias] != null ? +t[alias] : dflt;
    const m = t ? [val('a', 'm11', 1), val('b', 'm12', 0), val('c', 'm21', 0),
                   val('d', 'm22', 1), val('e', 'm41', 0), val('f', 'm42', 0)] : null;
    // Snapshot first: adding a path to itself must not iterate the array we push into.
    for (const sub of path._path.slice()) {
      const pts = m ? sub.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
                    : sub.pts.map(p => p.slice());
      this._path.push({pts, closed: sub.closed});
    }
  }

  _copyFrom(path) {
    for (const sub of path._path) this._path.push({pts: sub.pts.map(p => p.slice()), closed: sub.closed});
    this._cx = path._cx; this._cy = path._cy; this._sx = path._sx; this._sy = path._sy; this._hasPoint = path._hasPoint;
  }
}

// Parse an SVG path-data string into a CanvasPath (M/L/H/V/C/S/Q/T/A/Z, absolute
// and relative). Smooth curves (S/T) reflect the previous control point; A is an
// SVG endpoint-parameterized elliptical arc, converted to centre form.
function parseSvgPath(target, d) {
  const toks = String(d).match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/gi);
  if (!toks) return;
  let i = 0, px = 0, py = 0, sx = 0, sy = 0;      // current point + subpath start
  let pcx = 0, pcy = 0, lastCmd = '';             // previous control point (for S/T)
  const num = () => +toks[i++];
  while (i < toks.length) {
    const before = i;
    let cmd = toks[i];
    if (/[a-z]/i.test(cmd)) i++; else cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;   // implicit repeat
    const rel = cmd >= 'a';
    const up = cmd.toUpperCase();
    const ox = rel ? px : 0, oy = rel ? py : 0;
    if (up === 'M') {
      px = ox + num(); py = oy + num(); target.moveTo(px, py); sx = px; sy = py;
    } else if (up === 'L') {
      px = ox + num(); py = oy + num(); target.lineTo(px, py);
    } else if (up === 'H') {
      px = ox + num(); target.lineTo(px, py);
    } else if (up === 'V') {
      py = oy + num(); target.lineTo(px, py);
    } else if (up === 'C') {
      const c1x = ox + num(), c1y = oy + num(), c2x = ox + num(), c2y = oy + num(), ex = ox + num(), ey = oy + num();
      target.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey); pcx = c2x; pcy = c2y; px = ex; py = ey;
    } else if (up === 'S') {
      const c1x = /[cs]/i.test(lastCmd) ? 2 * px - pcx : px, c1y = /[cs]/i.test(lastCmd) ? 2 * py - pcy : py;
      const c2x = ox + num(), c2y = oy + num(), ex = ox + num(), ey = oy + num();
      target.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey); pcx = c2x; pcy = c2y; px = ex; py = ey;
    } else if (up === 'Q') {
      const cx = ox + num(), cy = oy + num(), ex = ox + num(), ey = oy + num();
      target.quadraticCurveTo(cx, cy, ex, ey); pcx = cx; pcy = cy; px = ex; py = ey;
    } else if (up === 'T') {
      const cx = /[qt]/i.test(lastCmd) ? 2 * px - pcx : px, cy = /[qt]/i.test(lastCmd) ? 2 * py - pcy : py;
      const ex = ox + num(), ey = oy + num();
      target.quadraticCurveTo(cx, cy, ex, ey); pcx = cx; pcy = cy; px = ex; py = ey;
    } else if (up === 'A') {
      const rx = num(), ry = num(), rot = num() * Math.PI / 180, large = num(), sweep = num();
      const ex = ox + num(), ey = oy + num();
      svgArc(target, px, py, rx, ry, rot, large, sweep, ex, ey); px = ex; py = ey;
    } else if (up === 'Z') {
      target.closePath(); px = sx; py = sy;
    } else break;
    lastCmd = cmd;
    if (i === before) break;   // no token consumed (e.g. a stray number after Z) → stop, don't loop
  }
}

// SVG elliptical-arc (endpoint form) → centre parameterization → ctx.ellipse.
function svgArc(target, x0, y0, rx, ry, rot, large, sweep, x, y) {
  if (rx === 0 || ry === 0) { target.lineTo(x, y); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  let lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = large !== sweep ? 1 : -1;
  let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num) / den);
  const cx1 = co * rx * y1 / ry, cy1 = -co * ry * x1 / rx;
  const cx = cos * cx1 - sin * cy1 + (x0 + x) / 2, cy = sin * cx1 + cos * cy1 + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dTheta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  target.ellipse(cx, cy, rx, ry, rot, theta, theta + dTheta, !sweep);
}

// 2D rendering context: image blit + readback (drawImage / getImageData /
// putImageData) plus rectangle + arbitrary-path rasterization (fill / stroke /
// clip) through the current transform, with solid-colour and gradient paints,
// shadows, and compositing. A Path2D can be filled / stroked / clipped directly.
export class CanvasRenderingContext2D {
  constructor(canvas, options) {
    this.canvas = canvas;
    const o = options || {};
    this._attrs = {
      alpha:              o.alpha !== false,
      desynchronized:     !!o.desynchronized,
      colorSpace:         o.colorSpace || 'srgb',
      willReadFrequently: !!o.willReadFrequently,
    };
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
    this.lang                     = '';
    this.filter                   = 'none';
    this.imageSmoothingQuality    = 'low';
    // Shadow: blur/offset go through validating setters (private _shadow* fields);
    // shadowColor is a plain field (parsed at draw time, invalid → no shadow).
    this.shadowBlur               = 0;
    this.shadowColor              = 'rgba(0, 0, 0, 0)';
    this.shadowOffsetX            = 0;
    this.shadowOffsetY            = 0;
    this._fill                    = {r: 0, g: 0, b: 0, a: 1};   // parsed fillStyle (solid)
    this._stroke                  = {r: 0, g: 0, b: 0, a: 1};   // parsed strokeStyle (solid)
    this._fillObj                 = null;                        // gradient fillStyle, if set
    this._strokeObj               = null;                        // gradient strokeStyle, if set
    this._clip                    = null;                        // clip mask (Uint8Array) or null
    this._lineDash                = [];
    this._m                       = [1, 0, 0, 1, 0, 0];         // current transform
    this._stack                   = [];                          // save()/restore() state
    this._pathObj                 = new CanvasPath(() => this._ctmScale());   // current default path
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

  // Shadow geometry: per spec the setters IGNORE a value that is negative (blur
  // only) or non-finite, keeping the previous one — a raw Infinity would hang the
  // blur and a NaN would wipe the canvas.
  get shadowBlur() { return this._shadowBlur; }
  set shadowBlur(v) { v = +v; if (isFinite(v) && v >= 0) this._shadowBlur = v; }
  get shadowOffsetX() { return this._shadowOffsetX; }
  set shadowOffsetX(v) { v = +v; if (isFinite(v)) this._shadowOffsetX = v; }
  get shadowOffsetY() { return this._shadowOffsetY; }
  set shadowOffsetY(v) { v = +v; if (isFinite(v)) this._shadowOffsetY = v; }

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

  // Drawing-state stack. save() snapshots the transform + the state fields the
  // vector surface reads; restore() pops the most recent (a no-op when empty).
  // The current path is NOT part of the drawing state — it persists across
  // save/restore, per spec.
  save() {
    const s = {
      m: this._m.slice(), fill: this._fill, stroke: this._stroke,
      fillObj: this._fillObj, strokeObj: this._strokeObj, clip: this._clip, lineDash: this._lineDash,
    };
    for (const k of STATE_KEYS) s[k] = this[k];
    this._stack.push(s);
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._m = s.m; this._fill = s.fill; this._stroke = s.stroke;
    this._fillObj = s.fillObj; this._strokeObj = s.strokeObj; this._clip = s.clip; this._lineDash = s.lineDash;
    for (const k of STATE_KEYS) this[k] = s[k];
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
  // The current default path lives in a CanvasPath (shared with Path2D); the
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

  // Average scale of the CTM, used to pick a curve/arc flattening resolution that
  // stays smooth in device pixels regardless of the transform (the CanvasPath's
  // scale provider).
  _ctmScale() {
    const m = this._m;
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) || 1;
  }

  // ── Path → device-space geometry ─────────────────────────────────────────
  // Map every subpath (≥2 points) of `pathObj` (the current default path, or a
  // Path2D) through the CTM to device-space rings.
  _devicePath(pathObj = this._pathObj) {
    const m = this._m, rings = [];
    for (const sub of pathObj._path) {
      if (sub.pts.length < 2) continue;
      const ring = [];
      for (const p of sub.pts) ring.push([m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]);
      rings.push(ring);
    }
    return rings;
  }

  // Build a device-space quad ring per path segment, offset by half the (user-
  // space) line width so the stroke scales with the CTM.
  _strokeRings(lw, pathObj = this._pathObj) {
    const m = this._m, half = lw / 2, rings = [];
    const tx = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    for (const sub of pathObj._path) {
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

  // ── Coverage: enumerate covered device pixels, calling emit(px, py, coverage) ──
  // The enumerators compute anti-aliased coverage (0..1); the caller's emit
  // composites at that coverage (or, for clip(), thresholds it into a mask),
  // keeping gradients / clip / shadow orthogonal. Integer-aligned geometry still
  // yields exact full-coverage pixels.

  // Axis-aligned device box: each pixel's coverage is its analytic area overlap
  // with the box, so a fractional edge is anti-aliased and an integer-aligned rect
  // fills exact whole pixels. The fast path for the untransformed / scale-only CTM.
  _enumBox(x0, y0, x1, y1, emit) {
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const xL = Math.max(0, Math.floor(x0)), xR = Math.min(cw - 1, Math.ceil(x1) - 1);
    const yT = Math.max(0, Math.floor(y0)), yB = Math.min(ch - 1, Math.ceil(y1) - 1);
    for (let py = yT; py <= yB; py++) {
      const oy = Math.min(py + 1, y1) - Math.max(py, y0);
      if (oy <= 0) continue;
      for (let px = xL; px <= xR; px++) {
        const ox = Math.min(px + 1, x1) - Math.max(px, x0);
        if (ox > 0) { const c = ox * oy; emit(px, py, c < 1 ? c : 1); }
      }
    }
  }

  // Anti-aliased scanline coverage of device-space polygon rings under a winding
  // rule. Each pixel row is sampled at S sub-scanlines (super-sampled in Y); on
  // each, the covered spans add their analytic X overlap into a coverage row.
  // 'nonzero' merges each contiguous non-zero-winding region (overlapping stroke
  // quads at a join covered once); 'evenodd' alternates spans (the strokeRect frame).
  _enumScanline(rings, rule, emit) {
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    let minY = Infinity, maxY = -Infinity;
    for (const ring of rings) for (const p of ring) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (!isFinite(minY)) return;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd   = Math.min(ch - 1, Math.ceil(maxY) - 1);
    const evenOdd = rule === 'evenodd';
    const S = 4, invS = 1 / S;
    let cov = this._covRow;
    if (!cov || cov.length < cw) cov = this._covRow = new globalThis.Float32Array(cw);
    const xs = [];
    for (let py = yStart; py <= yEnd; py++) {
      let tL = cw, tR = -1;
      for (let s = 0; s < S; s++) {
        const sy = py + (s + 0.5) * invS;
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
          for (let k = 0; k + 1 < xs.length; k += 2) {
            if (addSpanCoverage(cov, xs[k].x, xs[k + 1].x, invS, cw)) {
              if (spanRange[0] < tL) tL = spanRange[0]; if (spanRange[1] > tR) tR = spanRange[1];
            }
          }
        } else {
          let w = 0, start = 0;
          for (let k = 0; k < xs.length; k++) {
            const prev = w; w += xs[k].dir;
            if (prev === 0 && w !== 0) start = xs[k].x;
            else if (prev !== 0 && w === 0 && addSpanCoverage(cov, start, xs[k].x, invS, cw)) {
              if (spanRange[0] < tL) tL = spanRange[0]; if (spanRange[1] > tR) tR = spanRange[1];
            }
          }
        }
      }
      for (let px = tL; px <= tR; px++) {
        const c = cov[px];
        if (c > 0) { emit(px, py, c < 1 ? c : 1); cov[px] = 0; }   // emit + reset the row
      }
    }
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
  // painter `(buf, i, px, py, coverage) => void` that composites at the pixel's
  // AA coverage, or null when it paints nothing (a fully transparent solid, or a
  // singular CTM for a gradient).
  _painter(obj, solid) {
    const ga = this.globalAlpha, op = this._gco;
    if (obj instanceof CanvasGradient) {
      const inv = invertMatrix(this._m);
      if (!inv) return null;
      const sample = obj._sampler();
      return (buf, i, px, py, cov) => {
        const dx = px + 0.5, dy = py + 0.5;
        const c = sample(inv[0] * dx + inv[2] * dy + inv[4], inv[1] * dx + inv[3] * dy + inv[5]);
        if (c) compositePixel(buf, i, c, clamp01(c.a * ga * cov), op);
      };
    }
    const a = clamp01(solid.a * ga);
    if (a <= 0) return null;
    return (buf, i, px, py, cov) => compositePixel(buf, i, solid, cov >= 1 ? a : a * cov, op);
  }

  // Composite `painter` over every device pixel an enumerator reports (emit(px,
  // py, coverage)) that passes the clip mask. No shadow — clearRect and the shadow
  // pass itself use this directly.
  _composite(painter, enumerate) {
    const buf = this._buffer();
    if (!buf || !painter) return;
    const cw = this.canvas.width | 0, clip = this._clip;
    enumerate((px, py, cov) => {
      const idx = py * cw + px;
      if (clip && !clip[idx]) return;
      painter(buf, idx * 4, px, py, cov);
    });
  }

  // Paint an op, casting a shadow first when one is active (the shadow reuses the
  // op's AA coverage).
  _paintWith(painter, enumerate) {
    if (!painter) return;
    if (this._shadowActive()) this._shadowPass(set => enumerate((px, py, cov) => set(px, py, cov)));
    this._composite(painter, enumerate);
  }

  // A shadow is cast when a blur or offset makes it visible (0 blur + 0 offset
  // would sit exactly under the shape) and shadowColor isn't fully transparent.
  // The cheap geometry check short-circuits before parsing the colour, keeping
  // the no-shadow paint path (the common case) allocation- and parse-free.
  _shadowActive() {
    if (this.shadowBlur <= 0 && this.shadowOffsetX === 0 && this.shadowOffsetY === 0) return false;
    const c = parseColorRGBA(this.shadowColor);
    return !!c && c.a > 0;
  }

  // Paint the shadow for a draw op: `rasterize(set)` reports the op's coverage
  // via set(px, py, coverage0to1); that alpha plane is Gaussian-blurred, tinted
  // with shadowColor, offset by (shadowOffsetX, shadowOffsetY) in device space,
  // and composited under the actual draw (honoring the clip mask + globalAlpha).
  _shadowPass(rasterize) {
    const buf = this._buffer();
    if (!buf) return;
    const col = parseColorRGBA(this.shadowColor);
    if (!col || col.a <= 0) return;
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    const cov = new globalThis.Float32Array(cw * ch);
    rasterize((px, py, c) => {
      if (px >= 0 && px < cw && py >= 0 && py < ch) { const i = py * cw + px; if (c > cov[i]) cov[i] = c; }
    });
    const radius = Math.max(0, Math.round(this.shadowBlur / 2));
    const blurred = boxBlurAlpha(cov, cw, ch, radius);
    const ox = Math.round(this.shadowOffsetX), oy = Math.round(this.shadowOffsetY);
    const clip = this._clip, ga = this.globalAlpha;
    for (let py = 0; py < ch; py++) {
      const dy = py + oy;
      if (dy < 0 || dy >= ch) continue;
      for (let px = 0; px < cw; px++) {
        const sc = blurred[py * cw + px];
        if (sc <= 0) continue;
        const dx = px + ox;
        if (dx < 0 || dx >= cw) continue;
        const idx = dy * cw + dx;
        if (clip && !clip[idx]) continue;
        blendPixel(buf, idx * 4, col, clamp01(col.a * ga * sc));
      }
    }
  }

  // fill([path,] [fillRule]): rasterize the given path (or the current default
  // path), subpaths implicitly closed, under the winding rule ('nonzero' default,
  // or 'evenodd').
  fill(a, b) {
    const path = a instanceof CanvasPath ? a : this._pathObj;
    const ruleArg = a instanceof CanvasPath ? b : a;
    const rule = ruleArg === 'evenodd' ? 'evenodd' : 'nonzero';
    const rings = this._devicePath(path);
    if (rings.length) this._paintWith(this._painter(this._fillObj, this._fill),
                                      emit => this._enumScanline(rings, rule, emit));
  }

  // stroke([path]): thicken each segment into a device-space quad and paint the
  // whole set in one nonzero pass — the union covers overlaps (joins) exactly once,
  // so a translucent strokeStyle doesn't darken at corners. Butt caps / bevel-ish
  // joins (lineCap / lineJoin / dashes are stored but not yet honored).
  stroke(path) {
    const rings = this._strokeRings(this.lineWidth > 0 ? this.lineWidth : 1,
                                    path instanceof CanvasPath ? path : this._pathObj);
    if (rings.length) this._paintWith(this._painter(this._strokeObj, this._stroke),
                                      emit => this._enumScanline(rings, 'nonzero', emit));
  }

  // clip([path,] [fillRule]): intersect the clip region with the given path (or
  // the current default path), so subsequent draws are masked. Part of the drawing
  // state (save/restore'd); clip() only ever shrinks the region.
  clip(a, b) {
    const path = a instanceof CanvasPath ? a : this._pathObj;
    const ruleArg = a instanceof CanvasPath ? b : a;
    const rule = ruleArg === 'evenodd' ? 'evenodd' : 'nonzero';
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    const mask = new globalThis.Uint8Array(cw * ch);
    // The clip mask is binary — a pixel is inside when at least half-covered (AA
    // clip edges are a later refinement).
    this._enumScanline(this._devicePath(path), rule, (px, py, cov) => { if (cov >= 0.5) mask[py * cw + px] = 1; });
    if (this._clip) { const old = this._clip; for (let k = 0; k < mask.length; k++) mask[k] &= old[k]; }
    this._clip = mask;
  }

  // isPointInPath([path,] x, y [, fillRule]) — is the user-space point inside the
  // given path (or the current default path) under the winding rule? The point and
  // path share user space (the CTM applies to both), so no transform is needed —
  // consistent with how fill() paints.
  isPointInPath(a, b, c, d) {
    let path = this._pathObj, x, y, rule;
    if (a instanceof CanvasPath) { path = a; x = +b; y = +c; rule = d; }
    else { x = +a; y = +b; rule = c; }
    if (!allFinite(x, y)) return false;
    const evenOdd = rule === 'evenodd';
    let wind = 0, crossings = 0;
    for (const sub of path._path) {
      const pts = sub.pts, n = pts.length;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {                         // implicitly closed for fill
        const p1 = pts[i], p2 = pts[i + 1 === n ? 0 : i + 1];
        const y1 = p1[1], y2 = p2[1];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          if (p1[0] + (y - y1) / (y2 - y1) * (p2[0] - p1[0]) > x) { crossings++; wind += y2 > y1 ? 1 : -1; }
        }
      }
    }
    return evenOdd ? (crossings & 1) === 1 : wind !== 0;
  }

  // isPointInStroke([path,] x, y) — is the point within lineWidth/2 of the path?
  // (Butt caps / joins ignored, matching the stroke() approximation.)
  isPointInStroke(a, b, c) {
    let path = this._pathObj, x, y;
    if (a instanceof CanvasPath) { path = a; x = +b; y = +c; } else { x = +a; y = +b; }
    if (!allFinite(x, y)) return false;
    const half = (this.lineWidth > 0 ? this.lineWidth : 1) / 2;
    for (const sub of path._path) {
      const pts = sub.pts, n = pts.length;
      if (n < 2) continue;
      const segs = sub.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        if (distToSeg(x, y, pts[i], pts[i + 1 === n ? 0 : i + 1]) <= half) return true;
      }
    }
    return false;
  }

  // Reset the bitmap to transparent black and the context to its default state.
  reset() { this.canvas._pixels = null; this._resetState(); }
  getContextAttributes() { return {...this._attrs}; }
  isContextLost() { return false; }
  drawFocusIfNeeded() {}   // accessibility hint — no visual effect

  // ── Text ──────────────────────────────────────────────────────────────
  // Computed font-size (px) of an element via the cascade, or null when it can't
  // be resolved (no CSS set / not a DOM element / OffscreenCanvas).
  _computedFontSize(el) {
    try {
      if (el && el.nodeType === 1 && globalThis.getComputedStyle) {
        const fs = parseFloat(globalThis.getComputedStyle(el).fontSize);
        if (fs > 0) return fs;
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  // Base px for a font-relative unit: `em`/`%` resolve against the canvas
  // element's computed font-size, `rem` against the root's — falling back to the
  // 16px browser default (medium) when unset or on an OffscreenCanvas.
  _fontRelBase(unit) {
    if (unit === 'rem') {
      const doc = this.canvas && this.canvas.ownerDocument;
      return this._computedFontSize(doc && doc.documentElement) || 16;
    }
    return this._computedFontSize(this.canvas) || 16;
  }

  // Translate the CSS `font` shorthand to a pango font string ("Sans Bold 16")
  // scaled by `scale` (the device font size for a scaled CTM). Size honors px /
  // pt / em / rem / %; bold/italic and the first family are kept.
  _pangoFont(scale) {
    const s = String(this.font || '10px sans-serif').trim();
    const sm = /(-?\d*\.?\d+)(px|pt|em|rem|%)?/.exec(s);
    const val = sm ? parseFloat(sm[1]) : 10;
    const unit = sm && sm[2] || 'px';
    const px = unit === 'pt'  ? val * 96 / 72
             : unit === 'em'  ? val * this._fontRelBase('em')
             : unit === 'rem' ? val * this._fontRelBase('rem')
             : unit === '%'   ? val / 100 * this._fontRelBase('%')
             : val;
    const size = Math.max(1, Math.round(px * (scale || 1)));
    const weight = /\b(bold|[6-9]00)\b/i.test(s) ? ' Bold' : '';
    const style  = /\bitalic\b/i.test(s) ? ' Italic' : (/\boblique\b/i.test(s) ? ' Oblique' : '');
    // Family is everything after the size token (minus any /line-height); keep it
    // even when the size unit wasn't px, so a named family isn't lost.
    let fam = 'Sans';
    if (sm) {
      const after = s.slice(sm.index + sm[0].length).replace(/^\s*\/\s*[\d.]+\w*/, '').trim();
      const first = (after.split(',')[0] || '').trim().replace(/['"]/g, '');
      fam = PANGO_GENERIC[first.toLowerCase()] || first || 'Sans';
    }
    return `${fam}${style}${weight} ${size}`;
  }

  measureText(text) {
    text = String(text);
    const font = this._pangoFont(1);                 // user-space units (transform-independent)
    let m = measureCache.get(font + '\0' + text);
    if (!m) {
      const r = globalThis.__csim_renderText ? globalThis.__csim_renderText(text, font, true) : null;
      const asc = r ? r.ascent : 8, desc = r ? r.descent : 2;
      const w = r ? r.width : text.length * 6;
      m = {
        width:                    w,
        actualBoundingBoxLeft:    r ? -r.xoffset : 0,
        actualBoundingBoxRight:   w,
        actualBoundingBoxAscent:  r ? asc - r.yoffset : asc,
        actualBoundingBoxDescent: r ? (r.yoffset + r.height) - asc : desc,
        fontBoundingBoxAscent:    asc,
        fontBoundingBoxDescent:   desc,
        emHeightAscent:           asc,
        emHeightDescent:          desc,
        hangingBaseline:          asc * 0.8,
        alphabeticBaseline:       0,
        ideographicBaseline:      -desc,
      };
      if (measureCache.size > 4000) measureCache.clear();
      measureCache.set(font + '\0' + text, m);
    }
    return m;
  }

  fillText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this._fillObj, this._fill); }
  // strokeText is approximated as a filled glyph (glyph-outline stroking isn't
  // modeled) — the common use is a visible label; the fill/stroke colour differs.
  strokeText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this._strokeObj, this._stroke); }

  // Render `text` to a coverage mask (real system-font glyphs via the host) and
  // composite it, honoring textAlign / textBaseline, translate + scale of the CTM,
  // the fill/stroke paint (solid or gradient), globalAlpha, and the clip mask.
  // Rotation/shear of the CTM positions the anchor but doesn't rotate the glyphs.
  _drawText(text, x, y, maxWidth, obj, solid) {
    text = String(text);
    if (!text || !allFinite(x = +x, y = +y)) return;
    const buf = this._buffer();
    if (!buf || !globalThis.__csim_renderText) return;
    const scale = this._ctmScale() || 1;
    const r = globalThis.__csim_renderText(text, this._pangoFont(scale), false);
    if (!r || !r.refId) return;
    const mask = fetchTransfer(r.refId);
    if (!mask) return;
    const mwid = r.width | 0, mhei = r.height | 0;
    if (!mwid || !mhei) return;

    // maxWidth CONDENSES the line horizontally (never wraps): squash the mask's
    // x so the rendered advance fits. The device maxWidth is the user value × CTM
    // scale (the mask is already rendered at that scale).
    const devMax = (maxWidth != null && isFinite(+maxWidth) && +maxWidth > 0) ? +maxWidth * scale : 0;
    const xScale = devMax && r.width > devMax ? devMax / r.width : 1;
    const advance = r.width * xScale;

    const m = this._m;
    const ax = m[0] * x + m[2] * y + m[4], ay = m[1] * x + m[3] * y + m[5];   // device anchor
    const align = this._resolveTextAlign();
    const alignDX = align === 'center' ? advance / 2 : align === 'right' ? advance : 0;
    const lh = r.ascent + r.descent;                 // reference line within the layout box
    const baseY = this.textBaseline === 'top'    ? 0
                : this.textBaseline === 'hanging' ? r.ascent * 0.2
                : this.textBaseline === 'middle'  ? lh / 2
                : this.textBaseline === 'bottom' || this.textBaseline === 'ideographic' ? lh
                : r.ascent;                          // alphabetic (default)
    // Ink-box left in device space (the layout, including its x bearing, is
    // condensed by xScale). Output columns are sampled from the source so a
    // condensed run composites each device pixel once (no double-blend).
    const inkX = Math.round(ax - alignDX + r.xoffset * xScale);
    const inkY = Math.round(ay - baseY + r.yoffset);
    const outW = xScale === 1 ? mwid : Math.max(1, Math.round(mwid * xScale));

    const cw = this.canvas.width | 0, ch = this.canvas.height | 0, clip = this._clip, ga = this.globalAlpha, op = this._gco;
    // Per-pixel paint scaled by glyph coverage: gradient samples user space, a
    // solid colour composites directly.
    let paint;
    if (obj instanceof CanvasGradient) {
      const inv = invertMatrix(m);
      if (!inv) return;
      const sample = obj._sampler();
      paint = (i, px, py, cov) => {
        const c = sample(inv[0] * (px + 0.5) + inv[2] * (py + 0.5) + inv[4],
                         inv[1] * (px + 0.5) + inv[3] * (py + 0.5) + inv[5]);
        if (c) compositePixel(buf, i, c, clamp01(c.a * ga * cov), op);
      };
    } else {
      if (clamp01(solid.a * ga) <= 0) return;
      paint = (i, px, py, cov) => compositePixel(buf, i, solid, clamp01(solid.a * ga * cov), op);
    }
    // Walk the placed glyph coverage, yielding cb(dx, dy, coverage0to1) per pixel
    // (no clip — consumers apply it). Shared by the shadow pass and the paint.
    const walk = cb => {
      for (let my = 0; my < mhei; my++) {
        const dy = inkY + my;
        if (dy < 0 || dy >= ch) continue;
        const maskRow = my * mwid;
        for (let ox = 0; ox < outW; ox++) {
          const mx = xScale === 1 ? ox : Math.min(mwid - 1, Math.floor(ox / xScale));
          const cov = mask[maskRow + mx];
          if (!cov) continue;
          const dx = inkX + ox;
          if (dx < 0 || dx >= cw) continue;
          cb(dx, dy, cov / 255);
        }
      }
    };
    if (this._shadowActive()) this._shadowPass(set => walk(set));
    walk((dx, dy, cov) => {
      const idx = dy * cw + dx;
      if (clip && !clip[idx]) return;
      paint(idx * 4, dx, dy, cov);
    });
  }

  // textAlign resolves start/end against the (LTR) direction, matching our
  // left-to-right default.
  _resolveTextAlign() {
    return this.textAlign === 'start' ? 'left' : this.textAlign === 'end' ? 'right' : this.textAlign;
  }

  fillRect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    this._paintWith(this._painter(this._fillObj, this._fill), emit => this._enumRect(x, y, w, h, emit));
  }

  clearRect(x, y, w, h) {
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    // clearRect ignores fillStyle / globalAlpha and casts NO shadow — it clears
    // covered pixels (still honoring the clip mask), so it composites directly. A
    // partially-covered (AA) edge pixel is cleared proportionally (alpha scaled).
    this._composite((buf, i, px, py, cov) => {
      if (cov >= 1) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; }
      else { buf[i + 3] *= 1 - cov; }
    }, emit => this._enumRect(x, y, w, h, emit));
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
globalThis.Path2D                   = Path2D;
globalThis.OffscreenCanvas          = OffscreenCanvas;
globalThis.createImageBitmap        = createImageBitmap;
