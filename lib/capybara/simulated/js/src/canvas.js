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
import { SYSTEM_COLORS, ABSOLUTE_FONT_SIZE_PX }                        from './css-utils.js';

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

// --- sRGB ⇄ Display-P3 colour conversion -----------------------------------
// The two predefined canvas colour spaces share the sRGB transfer function, so
// a conversion is: gamma-expand → 3×3 linear-RGB matrix → gamma-compress. The
// matrices are the D65 sRGB-linear ⇄ Display-P3-linear transforms. A P3→sRGB
// result outside the sRGB gamut (a saturated wide colour) is clamped into [0,1],
// which is what a browser does when reading a wide value back as sRGB. Alpha is
// untouched. The ±3/255 tolerance in the WPT tests absorbs the rounding.
function srgbEotf(c) { return c <= 0.04045   ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function srgbOetf(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
const M_SRGB_TO_P3 = [0.82246197, 0.17753803, 0, 0.03319420, 0.96680580, 0, 0.01708263, 0.07239744, 0.91051993];
const M_P3_TO_SRGB = [1.22494018, -0.22494018, 0, -0.04205695, 1.04205695, 0, -0.01963755, -0.07863605, 1.09827360];
function colourMatrix(from, to) {
  if (from === to) return null;
  if (from === 'srgb'       && to === 'display-p3') return M_SRGB_TO_P3;
  if (from === 'display-p3' && to === 'srgb')       return M_P3_TO_SRGB;
  return null;   // unknown pair → leave unconverted
}
// Convert an RGBA byte buffer between colour spaces IN PLACE. No-op when the
// spaces match or the pair isn't modeled. Returns the buffer.
function convertColorSpace(data, from, to) {
  const M = colourMatrix(from, to);
  if (!M) return data;
  for (let i = 0; i < data.length; i += 4) {
    const r = srgbEotf(data[i] / 255), g = srgbEotf(data[i + 1] / 255), b = srgbEotf(data[i + 2] / 255);
    let lr = M[0] * r + M[1] * g + M[2] * b;
    let lg = M[3] * r + M[4] * g + M[5] * b;
    let lb = M[6] * r + M[7] * g + M[8] * b;
    lr = lr < 0 ? 0 : lr > 1 ? 1 : lr;
    lg = lg < 0 ? 0 : lg > 1 ? 1 : lg;
    lb = lb < 0 ? 0 : lb > 1 ? 1 : lb;
    data[i]     = Math.round(srgbOetf(lr) * 255);
    data[i + 1] = Math.round(srgbOetf(lg) * 255);
    data[i + 2] = Math.round(srgbOetf(lb) * 255);
  }
  return data;
}
// A paint colour ({r,g,b: 0-255, a: 0-1}) converted between colour spaces, so a
// solid / gradient / pattern fill lands in the destination canvas's colour space
// (getImageData reads it back per its requested space). Returns the same object
// when no conversion applies (the common sRGB-context path allocates nothing);
// scalar math, no typed-array allocation.
function convertPaintColor(c, from, to) {
  const M = colourMatrix(from, to);
  if (!M || !c) return c;
  const r = srgbEotf(c.r / 255), g = srgbEotf(c.g / 255), b = srgbEotf(c.b / 255);
  let lr = M[0] * r + M[1] * g + M[2] * b;
  let lg = M[3] * r + M[4] * g + M[5] * b;
  let lb = M[6] * r + M[7] * g + M[8] * b;
  lr = lr < 0 ? 0 : lr > 1 ? 1 : lr;
  lg = lg < 0 ? 0 : lg > 1 ? 1 : lg;
  lb = lb < 0 ? 0 : lb > 1 ? 1 : lb;
  return { r: Math.round(srgbOetf(lr) * 255), g: Math.round(srgbOetf(lg) * 255), b: Math.round(srgbOetf(lb) * 255), a: c.a };
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

// ── CSS Color 4/5 (color() / color-mix() / relative color) ──────────────────
// culori (as vendored) doesn't parse these, so they're handled here. A parsed
// Color-4 colour carries the sRGB floats (for further mixing) and its canonical
// `color(srgb …)` serialization alongside the 0..255 render channels.

// Serialize an sRGB component the way canvas does — trimmed decimal, no trailing 0s.
function fmtComp(x) { return String(Math.round(x * 1e6) / 1e6); }
function srgbCss(r, g, b, a) {
  const base = `color(srgb ${fmtComp(r)} ${fmtComp(g)} ${fmtComp(b)}`;
  return a >= 1 ? base + ')' : `${base} / ${fmtComp(a)})`;
}
function srgbColor(r, g, b, a) {
  return {r: Math.round(clamp01(r) * 255), g: Math.round(clamp01(g) * 255), b: Math.round(clamp01(b) * 255),
          a: clamp01(a), srgb: [r, g, b], css: srgbCss(r, g, b, a)};
}
const toSrgb = c => c.srgb ? [c.srgb[0], c.srgb[1], c.srgb[2], c.a] : [c.r / 255, c.g / 255, c.b / 255, c.a];

// Split / tokenize a function body at the top level (parentheses kept intact).
function splitTop(s, sep) {
  const out = []; let d = 0, cur = '';
  for (const ch of s) { if (ch === '(') d++; else if (ch === ')') d--; if (!d && ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim());
  return out;
}
function tokTop(s) {
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') { d++; cur += ch; } else if (ch === ')') { d--; cur += ch; }
    else if (!d && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// A number / <percentage> / 'none' token → a fraction of `scale`, or null.
function compFrac(tok, scale) {
  if (tok == null) return null;
  if (tok.toLowerCase() === 'none') return 0;
  const n = parseFloat(tok);
  if (!isFinite(n)) return null;
  return tok.endsWith('%') ? n / 100 : n / scale;
}

// CSS Color 4/5 forms. Returns a srgbColor (with .css / .srgb), or null.
function parseColor4(s, cc) {
  const low = s.toLowerCase();
  let m = /^(rgba?|hsla?|color)\(\s*from\s+([\s\S]+)\)$/i.exec(s);
  if (m) return parseRelativeColor(m[1].toLowerCase(), m[2].trim(), cc);
  if (low.startsWith('color-mix(') && (m = /^color-mix\(\s*([\s\S]+)\)$/i.exec(s))) return parseColorMix(m[1], cc);
  if (low.startsWith('color(') && (m = /^color\(\s*([\s\S]+)\)$/i.exec(s))) return parseColorFunc(m[1], cc);
  return null;
}
function parseColorFunc(body) {
  const slash = splitTop(body, '/'), toks = tokTop(slash[0]);
  if (toks.length < 4 || toks[0].toLowerCase() !== 'srgb') return null;   // only srgb modeled
  const r = compFrac(toks[1], 1), g = compFrac(toks[2], 1), b = compFrac(toks[3], 1);
  if (r == null || g == null || b == null) return null;
  const a = slash[1] != null ? compFrac(tokTop(slash[1])[0], 1) : 1;
  return srgbColor(r, g, b, a == null ? 1 : a);
}
function parseColorMix(body, cc) {
  const parts = splitTop(body, ',');
  if (parts.length < 3 || !/^in\s+srgb$/i.test(parts[0])) return null;   // only "in srgb" modeled
  const one = p => {
    const t = tokTop(p);
    let pct = null;   // the percentage may precede or follow the colour
    if (t.length >= 2 && t[t.length - 1].endsWith('%')) pct = parseFloat(t.pop());
    else if (t.length >= 2 && t[0].endsWith('%')) pct = parseFloat(t.shift());
    const col = parseColorRGBA(t.join(' '), cc);
    return col ? {c: toSrgb(col), pct} : null;
  };
  const a = one(parts[1]), b = one(parts[2]);
  if (!a || !b) return null;
  let p1 = a.pct, p2 = b.pct;   // CSS Color 5 percentage normalization
  if (p1 == null && p2 == null) { p1 = p2 = 50; } else if (p1 == null) p1 = 100 - p2; else if (p2 == null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const w1 = p1 / sum, w2 = p2 / sum;
  // Interpolate PREMULTIPLIED in srgb (a rectangular space); when the percentages sum
  // to < 100% the result alpha is scaled by that sum (CSS Color 5).
  const pm = c => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
  const pa = pm(a.c), pb = pm(b.c), mix = i => pa[i] * w1 + pb[i] * w2;
  let ao = mix(3);
  const un = i => (ao > 0 ? mix(i) / ao : 0);
  const r = un(0), g = un(1), bch = un(2);
  if (sum < 100) ao *= sum / 100;
  return srgbColor(r, g, bch, ao);
}
function parseRelativeColor(fn, body, cc) {
  const slash = splitTop(body, '/'), toks = tokTop(slash[0]);
  const origin = parseColorRGBA(toks[0], cc);
  if (!origin) return null;
  let idx = 1;
  const isColorFn = fn === 'color';
  if (isColorFn) { if ((toks[idx] || '').toLowerCase() !== 'srgb') return null; idx++; }   // only srgb
  const chan = toks.slice(idx, idx + 3);
  if (chan.length < 3) return null;
  const [or, og, ob, oa] = toSrgb(origin);
  // rgb(from …) channel keywords are 0..255; color(from … srgb …) are 0..1.
  const scale = isColorFn ? 1 : 255;
  const env = {__proto__: null, r: or * scale, g: og * scale, b: ob * scale, alpha: oa};   // null proto: no Object.prototype keys
  const resolve = tok => (tok in env ? env[tok] / scale : compFrac(tok, scale));
  const r = resolve(chan[0].toLowerCase()), g = resolve(chan[1].toLowerCase()), b = resolve(chan[2].toLowerCase());
  if (r == null || g == null || b == null) return null;
  let a = oa;
  if (slash[1] != null) {                                  // a `/` with a missing / invalid alpha is an invalid colour
    const at = (tokTop(slash[1])[0] || '').toLowerCase();
    a = at === 'alpha' ? oa : compFrac(at, 1);
    if (a == null) return null;
  }
  return srgbColor(r, g, b, a);
}

// Parse a CSS colour to `{r, g, b, a}` (a in 0..1; a Color-4 result also carries
// `.srgb` floats and `.css`), or null when unparseable — an invalid `fillStyle` /
// `strokeStyle` assignment is ignored per spec. The `#rgb`-family hex forms are
// handled inline (cheap, and available during the snapshot build before
// `__csimVendor` is wired); Color 4/5 forms are handled by `parseColor4`;
// everything else routes through culori's canonical `rgb()/rgba()` serialization.
// `cc` is the resolved `currentColor` (default opaque black) for nested keywords.
function parseColorRGBA(str, cc) {
  if (typeof str !== 'string') return null;
  let s = str.trim();
  if (s.toLowerCase() === 'currentcolor') {   // resolve to `cc` (guarding a self-referential cc)
    return cc && cc.toLowerCase() !== 'currentcolor' ? parseColorRGBA(cc, cc) : {r: 0, g: 0, b: 0, a: 1};
  }
  const c4 = parseColor4(s, cc || 'black');
  if (c4) return c4;
  // CSS tokenization auto-closes a function left open at end-of-input, so
  // `rgb(0, 255, 0` parses as `rgb(0, 255, 0)` (2d.fillStyle.parse.rgb-eof).
  const opens = (s.match(/\(/g) || []).length, closes = (s.match(/\)/g) || []).length;
  if (opens > closes) s += ')'.repeat(opens - closes);
  // <color> keywords and function names are ASCII case-insensitive, so fold to
  // lowercase (a mixed-case `TrAnSpArEnT` must resolve). Hex digits are unaffected.
  s = s.toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
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
  // A bare run of hex digits without the leading `#` is NOT a valid CSS <color>
  // (culori parses it leniently as hex, e.g. "800000" → #800000); reject it, so a
  // stray number coerced to a string is ignored rather than silently applied.
  if (/^[0-9a-f]+$/.test(s)) return null;
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

// Intersection of the line through `p` with direction `d1` and the line through
// `q` with direction `d2` (both [x,y]); null when (near-)parallel. Used for the
// miter-join apex.
function lineIntersect(p, d1, q, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * d2[1] - (q[1] - p[1]) * d2[0]) / den;
  return [p[0] + d1[0] * t, p[1] + d1[1] * t];
}

// Twice the signed area of a device-space polygon ring (shoelace); its sign is
// the winding direction. Stroke rings are normalized to one orientation so the
// nonzero fill unions them without a join seam cancelling to a hole.
function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[i + 1 === n ? 0 : i + 1];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

// Split a polyline into the "on" sub-polylines of a dash pattern. `dashes` is the
// (even-length) on/off run-length list, `offset` shifts where the pattern starts;
// both are measured in the stroke's user space, along the path. A closed polyline
// includes its closing edge, and a dash spanning the start/end seam is stitched back
// into one continuous piece (so the seam draws a join, not two caps). Returns a list
// of {pts, closed} pieces, each with pts.length ≥ 2. A zero-length "on" run (the
// dotted-line pattern, setLineDash([0, gap]) with round/square caps) is not yet
// rendered — it collapses to a single point and is dropped; see the canvas backlog.
function dashPolyline(pts, closed, dashes, offset) {
  let patLen = 0;
  for (const d of dashes) patLen += d;
  const whole = closed ? pts.concat([pts[0]]) : pts;
  if (patLen <= 0) return [{pts: whole, closed}];              // empty pattern → solid
  const verts = whole;
  // Position the pattern cursor from the offset (which dash run, how far into it).
  let phase = ((offset % patLen) + patLen) % patLen, di = 0;
  while (phase >= dashes[di]) { phase -= dashes[di]; di = (di + 1) % dashes.length; }
  const startOn = (di % 2) === 0;
  let on = startOn, remain = dashes[di] - phase;
  const pieces = [];
  let cur = on ? [verts[0]] : null;
  for (let s = 0; s + 1 < verts.length; s++) {
    const ax = verts[s][0], ay = verts[s][1], bx = verts[s + 1][0], by = verts[s + 1][1];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;
    const ux = (bx - ax) / segLen, uy = (by - ay) / segLen;
    let t = 0;
    while (segLen - t > 1e-9) {
      const step = Math.min(remain, segLen - t);
      t += step; remain -= step;
      const px = ax + ux * t, py = ay + uy * t;
      if (on) cur.push([px, py]);
      if (remain <= 1e-9) {                                  // crossed a dash boundary
        if (on && cur.length >= 2) pieces.push({pts: cur, closed: false});
        di = (di + 1) % dashes.length; on = !on; remain = dashes[di];
        cur = on ? [[px, py]] : null;
      }
    }
  }
  // A genuine "on" run that reaches the last vertex ends exactly at the seam.
  let seamEnd = null;
  if (on && cur && cur.length >= 2) { seamEnd = {pts: cur, closed: false}; pieces.push(seamEnd); }
  // If the pattern is also "on" leaving the seam (startOn), that run is continuous
  // across it: stitch the seam-ending run onto the seam-starting one so the seam draws
  // a join, not two caps — or, if the whole loop is one "on" run, mark it closed.
  if (closed && startOn && seamEnd) {
    if (pieces.length > 1) { pieces.pop(); seamEnd.pts.pop(); pieces[0].pts = seamEnd.pts.concat(pieces[0].pts); }
    else seamEnd.closed = true;
  }
  return pieces;
}

// Point-in-polygon over a set of (implicitly closed) rings by a horizontal ray-cast:
// even-odd uses the crossing parity, nonzero the signed winding number. Shared by
// isPointInPath (device path) and isPointInStroke (stroke rings).
function pointInRings(rings, x, y, evenOdd) {
  let wind = 0, crossings = 0;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i], p2 = ring[i + 1 === n ? 0 : i + 1];
      const y1 = p1[1], y2 = p2[1];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        if (p1[0] + (y - y1) / (y2 - y1) * (p2[0] - p1[0]) > x) { crossings++; wind += y2 > y1 ? 1 : -1; }
      }
    }
  }
  return evenOdd ? (crossings & 1) === 1 : wind !== 0;
}

// A point lying exactly on a ring edge counts as inside — for isPointInPath (a point
// on the fill boundary is "inside" per spec) and isPointInStroke (e.g. the centre of a
// butt cap at a dash's start). The winding raycast drops such points because the
// crossing sits on the point itself, so test the edges directly. The tolerance is in
// device space; queries a hair off the edge (WPT probes ±0.01) stay outside.
function pointOnRingEdge(rings, x, y) {
  for (const ring of rings) {
    // A zero-area subpath — a bare line or a repeated point — paints nothing (for fill
    // OR stroke), so a point "on" it is not on any painted edge. Only the boundary of a
    // region with real enclosed area counts as inside.
    if (ringSignedArea(ring) === 0) continue;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      if (distToSeg(x, y, ring[i], ring[i + 1 === n ? 0 : i + 1]) <= 1e-6) return true;
    }
  }
  return false;
}

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

// The @font-face src URL for `family` (from a document stylesheet rule or a
// programmatically-added FontFace), or ''. Memoized per document keyed by lowercased
// family, and invalidated when the DOM mutates (a stylesheet / FontFace may have been
// added) via the settle generation — so a steady draw loop keeps hitting the cache
// while a dynamically-injected @font-face is still picked up.
function resolveFontFace(doc, family) {
  const key = family.toLowerCase();
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  let cache = doc.__csimFontFaces;
  if (!cache || doc.__csimFontFacesGen !== gen) {
    cache = doc.__csimFontFaces = new globalThis.Map();
    doc.__csimFontFacesGen = gen;
  }
  if (cache.has(key)) return cache.get(key);
  const url = fontFaceSrc(doc, key);
  cache.set(key, url);
  return url;
}

function fontFaceSrc(doc, key) {
  const sheets = doc.styleSheets;
  for (let i = 0; sheets && i < sheets.length; i++) {
    let rules;
    try { rules = sheets[i].cssRules; } catch (_) { continue; }   // cross-origin sheet
    for (let j = 0; rules && j < rules.length; j++) {
      const r = rules[j];
      if (!r || r.type !== 5 /* CSSRule.FONT_FACE_RULE, realm-safe */ || !r.style) continue;
      const fam = (r.style.getPropertyValue('font-family') || '').trim().replace(/['"]/g, '');
      if (fam.toLowerCase() === key) {
        const u = fontFaceUrl(r.style.getPropertyValue('src'));
        if (u) return u;
      }
    }
  }
  // The CSS Font Loading API set (document.fonts.add(new FontFace(name, 'url(…)'))).
  const set = doc.fonts;
  let found = '';
  if (set && typeof set.forEach === 'function') {
    set.forEach(f => {
      if (!found && f && String(f.family).replace(/['"]/g, '').toLowerCase() === key) found = fontFaceUrl(f._source);
    });
  }
  return found;
}

// The first url() target in a CSS `src` value (or a FontFace source string), or ''.
function fontFaceUrl(src) {
  const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(typeof src === 'string' ? src : '');
  return m ? m[2].trim() : '';
}

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
const CSS_LENGTH = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:px|cm|mm|q|in|pc|pt|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax)$/i;
function parseCssLength(v) {
  v = String(v).trim();
  if (CSS_LENGTH.test(v)) return v.toLowerCase();   // normalize the unit case ('1PX' → '1px')
  // A unitless number is a valid <length> only when it is zero (any spelling: 0, +0, 0.0).
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) && Number(v) === 0 ? '0px' : null;
}

// ── Canvas `font` shorthand: keyword classes for parse + canonical serialize ──
const FONT_STYLE_KW   = new Set(['italic', 'oblique']);
const FONT_VARIANT_KW = new Set(['small-caps']);
const FONT_WEIGHT_KW  = new Set(['bold', 'bolder', 'lighter']);
const FONT_STRETCH_KW = new Set(['ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded']);
const FONT_SYSTEM_KW  = new Set(['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);
const FONT_GENERIC_KW = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'math', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'fangsong']);
// CSS-wide keywords are not valid <font-family> names (a lone one makes the value invalid).
const CSS_WIDE_KW     = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default']);

// CSSOM number serialization: shortest round-trippable form (drop a trailing `.0`).
function fmtCssNum(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

// Serialize one font-family name for the canonical `font` value: a generic keyword and a
// bare identifier sequence pass through (space-joined), anything requiring quotes (a
// parsed <string>, or a name with punctuation) becomes an escaped double-quoted string.
function serializeFontFamily(name, wasString) {
  if (!wasString) {
    if (FONT_GENERIC_KW.has(name.toLowerCase())) return name.toLowerCase();   // generics canonicalize lower-case
    if (/^[A-Za-z_][\w-]*(?: [A-Za-z_][\w-]*)*$/.test(name)) return name;      // bare identifier run
  }
  return '"' + name.replace(/[\\"]/g, '\\$&') + '"';
}

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

// The canvas "serialize a colour": a Color-4 result keeps its canonical
// `color(srgb …)` form; otherwise an opaque colour → lowercase `#rrggbb`, a
// translucent one → `rgba(r, g, b, a)` — what `ctx.fillStyle` reads back.
function serializeCanvasColor(c) {
  if (c.css) return c.css;
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
// The non-separable blend modes (hue/saturation/color/luminosity) still fall back
// to source-over.
const KNOWN_GCO = new globalThis.Set([
  'source-over', 'source-in', 'source-out', 'source-atop',
  'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'copy', 'xor', 'lighter', 'plus-lighter', 'clear',
  ...Object.keys(BLEND), 'hue', 'saturation', 'color', 'luminosity',
]);

// Operators that also CLEAR the uncovered destination (not just blend the covered
// pixels): they need a whole-canvas pass, not the per-covered-pixel path. NOTE 'clear'
// is NOT here — like xor it affects only the source-covered region (compositePixel maps
// it to a transparent result there), leaving the uncovered destination untouched.
const WHOLE_CANVAS_GCO = new globalThis.Set([
  'source-in', 'source-out', 'destination-in', 'destination-atop', 'copy',
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
    switch (op) {                           // Porter-Duff blend factors
      case 'destination-over': Fa = 1 - ab; Fb = 1;      break;
      case 'destination-out':  Fa = 0;      Fb = 1 - as; break;
      case 'source-atop':      Fa = ab;     Fb = 1 - as; break;
      case 'xor':              Fa = 1 - ab; Fb = 1 - as; break;
      // The whole-canvas operators (their UNCOVERED-destination clear is handled
      // by the caller's whole-canvas pass; here is just the covered-pixel blend):
      case 'source-in':        Fa = ab;     Fb = 0;      break;
      case 'source-out':       Fa = 1 - ab; Fb = 0;      break;
      case 'destination-in':   Fa = 0;      Fb = as;     break;
      case 'destination-atop': Fa = 1 - ab; Fb = as;     break;
      case 'copy':             Fa = 1;      Fb = 0;      break;
      case 'clear':            Fa = 0;      Fb = 0;      break;   // → fully transparent
      default:                 Fa = 1;      Fb = 1 - as; break;   // source-over + fallback
    }
    ao = as * Fa + ab * Fb;
    pr = as * Fa * sr + ab * Fb * dr; pg = as * Fa * sg + ab * Fb * dg; pb = as * Fa * sb + ab * Fb * db;
  }
  if (ao <= 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
  buf[i] = pr / ao * 255; buf[i + 1] = pg / ao * 255; buf[i + 2] = pb / ao * 255; buf[i + 3] = ao * 255;
}

// Invert a 2D affine matrix `[a, b, c, d, e, f]`, or null when singular — used to
// map a device pixel back to user space for gradient sampling.
// A CTM whose 2×2 linear part has a zero / non-finite determinant is non-invertible:
// it collapses the plane to a line or point, so nothing has fill interior or stroke
// area. isPointInPath / isPointInStroke both return false for such a transform
// (matching fill() / stroke() painting nothing) — a cheap determinant test that
// avoids allocating a discarded inverse.
function ctmSingular(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return !det || !isFinite(det);
}

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
        globalThis.btoa(bytes), cropForm ? 0 : (hasRW ? rwU : 0), cropForm ? 0 : (hasRH ? rhU : 0));
      if (!decoded) return invalid();
      const pixelBytes = fetchTransfer(decoded.refId) || fetchedToBytes(decoded.pixels);
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

// A linear or radial gradient set as a fill/stroke style. Colour stops are kept
// sorted by offset (stable for equal offsets), and `_sampler()` returns a per-
// point colour function so fill/stroke can evaluate the gradient per pixel.
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

  // Sampler (ux, uy) → colour|null (null only outside a non-repeated axis), with
  // the inverse pattern transform + repetition wrapping hoisted out of the loop.
  _sampler() {
    const inv = invertMatrix(this._m) || [1, 0, 0, 1, 0, 0];
    const w = this._w, h = this._h, px = this._px;
    const repX = this._rep === 'repeat' || this._rep === 'repeat-x';
    const repY = this._rep === 'repeat' || this._rep === 'repeat-y';
    return (ux, uy) => {
      const x = inv[0] * ux + inv[2] * uy + inv[4], y = inv[1] * ux + inv[3] * uy + inv[5];
      let ix = Math.floor(x), iy = Math.floor(y);
      if (repX) ix = ((ix % w) + w) % w; else if (ix < 0 || ix >= w) return null;
      if (repY) iy = ((iy % h) + h) % h; else if (iy < 0 || iy >= h) return null;
      const i = (iy * w + ix) * 4;
      return {r: px[i], g: px[i + 1], b: px[i + 2], a: px[i + 3] / 255};
    };
  }
}

// The path-building surface (the CanvasPath IDL mixin) shared by the context's
// current default path and by Path2D. Subpaths are arrays of user-space points;
// curves and arcs are flattened on the way in at a resolution from `_scale()` —
// the owning context's CTM scale, or 1 for a standalone Path2D.
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

  // Convert a user-space point to its STORED form: the add-time-CTM-baked device
  // point for a context's default path, or the raw point for a Path2D. The current
  // point (`_cx`/`_cy`/`_sx`/`_sy`) stays in USER space for the curve/arc math; only
  // the stored `pts` are baked.
  _store(x, y) {
    if (this._transformFn) {
      const m = this._transformFn();
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }
    return [x, y];
  }

  // Start a new subpath at (x, y) and make it the current point.
  _moveToPoint(x, y) {
    this._sub = {pts: [this._store(x, y)], closed: false};
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
    this._sub.pts.push(this._store(x, y)); this._cx = x; this._cy = y;
  }

  closePath() {
    if (!this._sub || this._sub.pts.length === 0) return;
    this._sub.closed = true;
    // The new subpath begins at the SAME (already-stored) first point of the closed
    // subpath — reuse it rather than re-baking `_sx/_sy` with the current transform,
    // which would misplace it if the CTM changed since this subpath's moveTo.
    const first = this._sub.pts[0].slice();
    this._sub = {pts: [first], closed: false};
    this._path.push(this._sub);
    this._hasPoint = true;
    // Express that point in USER space for the curve/arc math (inverse of the add-
    // time transform for a baked default path; the raw point itself for a Path2D).
    let ux = first[0], uy = first[1];
    if (this._transformFn) {
      const inv = invertMatrix(this._transformFn());
      if (inv) { ux = inv[0] * first[0] + inv[2] * first[1] + inv[4]; uy = inv[1] * first[0] + inv[3] * first[1] + inv[5]; }
    }
    this._cx = this._sx = ux; this._cy = this._sy = uy;
  }

  rect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h)) return;
    this._path.push({pts: [this._store(x, y), this._store(x + w, y), this._store(x + w, y + h), this._store(x, y + h)], closed: true});
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
    if (flip) sub.pts.reverse();          // reverse the winding for a net-negative-dimension rect
    this._moveToPoint(x, y);   // like rect(), leave a fresh subpath at (x, y)
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    argc(arguments.length, 6);
    if (!allFinite(c1x = +c1x, c1y = +c1y, c2x = +c2x, c2y = +c2y, x = +x, y = +y)) return;
    this._ensurePoint(c1x, c1y);   // spec: seed a subpath at the first control point
    const x0 = this._cx, y0 = this._cy, sub = this._sub;
    const n = Math.min(256, Math.max(8, Math.ceil(this._scale() *
      (Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y)) / 8)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      sub.pts.push(this._store(a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y));
    }
    this._cx = x; this._cy = y;
  }

  quadraticCurveTo(cx, cy, x, y) {
    argc(arguments.length, 4);
    if (!allFinite(cx = +cx, cy = +cy, x = +x, y = +y)) return;
    this._ensurePoint(cx, cy);     // spec: seed a subpath at the control point
    const x0 = this._cx, y0 = this._cy, sub = this._sub;
    const n = Math.min(256, Math.max(8, Math.ceil(this._scale() *
      (Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy)) / 8)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      sub.pts.push(this._store(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y));
    }
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
    // Sweep magnitude in [0, 2π], signed by direction. A range that is an exact
    // nonzero multiple of a full turn (e.g. the common `arc(0, 2π, true)`) mods to
    // 0 but must draw the whole circle, not nothing — browsers render it full.
    let delta;
    if (!ccw) {
      const d = a1 - a0;
      delta = d >= TAU ? TAU : (d % TAU + TAU) % TAU;
      if (delta === 0 && d !== 0) delta = TAU;
    } else {
      const d = a0 - a1;
      delta = d >= TAU ? -TAU : -((d % TAU + TAU) % TAU);
      if (delta === 0 && d !== 0) delta = -TAU;
    }
    const maxR = Math.max(rx, ry) * this._scale();
    const n = Math.min(2048, Math.max(6, Math.ceil(Math.abs(delta) / TAU * Math.max(12, maxR))));
    // For a PARTIAL arc, cluster the samples toward both ends (cosine spacing) rather
    // than uniformly: the stroke's end CAP is built perpendicular to the terminal CHORD,
    // and a uniform chord subtends the full step angle, so the cap tilts by half of it
    // and a thick stroke overshoots the true endpoint into the wrong region. Denser end
    // segments make the terminal chords hug the true tangent — at the SAME sample count,
    // so no extra cost — while the coarser middle keeps ample body fidelity. Stay uniform
    // when: (a) it's a FULL turn (no caps, and its ends coincide — cosine would starve the
    // far side); or (b) the device radius is small enough that the sample count sits near
    // the floor, where cosine's wider mid step would bulge the body a visible amount (a
    // small arc's caps overshoot little in absolute terms, so it needs no help).
    const uniform = Math.abs(delta) >= TAU - 1e-9 || maxR < 16;
    let p;
    for (let i = 0; i <= n; i++) {
      const u = i / n, s = uniform ? u : (1 - Math.cos(Math.PI * u)) / 2;
      p = pointAt(a0 + delta * s);
      sub.pts.push(this._store(p[0], p[1]));
    }
    // The last sample (i = n, s = 1) is exactly the arc endpoint; reuse it.
    this._cx = p[0]; this._cy = p[1]; this._hasPoint = true;
  }

  arcTo(x1, y1, x2, y2, r) {
    argc(arguments.length, 5);
    if (!allFinite(x1 = +x1, y1 = +y1, x2 = +x2, y2 = +y2, r = +r)) return;
    if (r < 0) throw new globalThis.DOMException('arcTo: the radius is negative', 'IndexSizeError');
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
    const m = transform ? matrix2DInit(transform) : null;
    if (m && !m.every(isFinite)) return;   // a non-finite transform adds nothing
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
    this._covShift                = null;                        // device offset for shadow rasterization
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

  // ── Path → device-space geometry ─────────────────────────────────────────
  // Map every subpath (≥2 points) of `pathObj` (the current default path, or a
  // Path2D) through the CTM to device-space rings.
  _devicePath(pathObj = this._pathObj) {
    const rings = [];
    // The default path's points are already device-space (the CTM was baked in at
    // add-time); a Path2D's are raw, so apply the current CTM now.
    if (pathObj._baked) {
      for (const sub of pathObj._path) if (sub.pts.length >= 2) rings.push(sub.pts);
      return rings;
    }
    const m = this._m;
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
  // Thicken a path into device-space polygon rings to fill (nonzero) as the
  // stroke. Each segment becomes an offset quad; caps close the two open ends of
  // an open subpath (butt = flat, square = extended rect, round = disc) and joins
  // fill the outer wedge at each interior/closing vertex (bevel = triangle, miter
  // = apex triangle within miterLimit else bevel, round = disc). Offsets are in
  // user space (so the CTM scales/shears the width), then mapped to device. All
  // rings are normalized to one winding so overlapping pieces union instead of
  // cancelling.
  _strokeRings(lw, pathObj = this._pathObj, cap = this._lineCap, join = this._lineJoin, miterLimit = this._miterLimit) {
    const m = this._m, half = lw / 2, rings = [];
    const tx = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    // Offsetting works in the CURRENT-transform "user" space so a non-uniform CTM
    // gives the correct elliptical pen. A Path2D's points are already user-space; the
    // default path's are device (CTM baked at add-time), so map them back through the
    // inverse current transform first — the stroke pen still uses the current CTM,
    // even when the path was built under a different one. A singular CTM strokes nothing.
    const inv = pathObj._baked ? invertMatrix(m) : null;
    if (pathObj._baked && !inv) return rings;
    const toU = inv ? (p) => [inv[0] * p[0] + inv[2] * p[1] + inv[4], inv[1] * p[0] + inv[3] * p[1] + inv[5]] : null;
    // A user-space circle of radius `half`, polygon-approximated + mapped to device.
    const disc = (cx, cy) => {
      const N = 24, ring = [];
      for (let k = 0; k < N; k++) {
        const a = k / N * 2 * Math.PI;
        ring.push(tx(cx + Math.cos(a) * half, cy + Math.sin(a) * half));
      }
      return ring;
    };
    // A dash pattern breaks each subpath into "on" pieces (each an open polyline
    // with its own caps); an empty pattern strokes the subpath whole. Dashes are in
    // the same user space as the pen, so they scale with the CTM.
    const dash = this._lineDash, dashOff = this._lineDashOffset || 0;
    for (const sub of pathObj._path) {
      const pts = toU ? sub.pts.map(toU) : sub.pts;
      if (pts.length < 2) continue;
      if (dash.length) {
        for (const piece of dashPolyline(pts, sub.closed, dash, dashOff)) {
          this._strokePolyline(rings, piece.pts, piece.closed, tx, disc, half, cap, join, miterLimit);
        }
      } else {
        this._strokePolyline(rings, pts, sub.closed, tx, disc, half, cap, join, miterLimit);
      }
    }
    for (const ring of rings) if (ringSignedArea(ring) < 0) ring.reverse();
    return rings;
  }

  // Thicken one polyline into stroke rings: an offset quad per segment, joins at the
  // interior/closing vertices, and (for an open polyline) caps at the two ends.
  _strokePolyline(rings, pts, closed, tx, disc, half, cap, join, miterLimit) {
    const n = pts.length;
    if (n < 2) return;
    const segCount = closed ? n : n - 1;
    const segs = [];
    for (let i = 0; i < segCount; i++) {
      const p1 = pts[i], p2 = pts[i + 1 === n ? 0 : i + 1];
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;   // skip a zero-length segment (repeated point)
      const ux = dx / len, uy = dy / len, nx = -uy * half, ny = ux * half;
      segs.push({ p1, p2, ux, uy, nx, ny });
      rings.push([tx(p1[0] + nx, p1[1] + ny), tx(p2[0] + nx, p2[1] + ny),
                  tx(p2[0] - nx, p2[1] - ny), tx(p1[0] - nx, p1[1] - ny)]);
    }
    if (!segs.length) return;
    const joinCount = closed ? segs.length : segs.length - 1;
    for (let i = 0; i < joinCount; i++) {
      this._addJoin(rings, tx, disc, segs[i].p2, segs[i], segs[(i + 1) % segs.length], half, join, miterLimit);
    }
    if (!closed) {
      this._addCap(rings, tx, disc, segs[0], true, half, cap);
      this._addCap(rings, tx, disc, segs[segs.length - 1], false, half, cap);
    }
  }

  // Fill the wedge at the vertex `V` between incoming segment `a` and outgoing `b`.
  _addJoin(rings, tx, disc, V, a, b, half, join, miterLimit) {
    if (join === 'round') { rings.push(disc(V[0], V[1])); return; }
    const cross = a.ux * b.uy - a.uy * b.ux;
    if (Math.abs(cross) < 1e-9) return;   // collinear vertices leave no gap
    // The gap is on the convex (outer) side, opposite the turn: a left turn
    // (cross > 0) bulges to the −normal side, a right turn to the +normal side.
    const s   = cross < 0 ? 1 : -1;
    const o1  = [V[0] + s * a.nx, V[1] + s * a.ny];   // incoming outer corner
    const o2  = [V[0] + s * b.nx, V[1] + s * b.ny];   // outgoing outer corner
    rings.push([tx(o1[0], o1[1]), tx(o2[0], o2[1]), tx(V[0], V[1])]);   // bevel wedge
    if (join === 'bevel') return;
    const apex = lineIntersect(o1, [a.ux, a.uy], o2, [b.ux, b.uy]);
    if (!apex) return;
    // miterLength / lineWidth == dist(apex, V) / half; beyond miterLimit, stay bevel.
    if (Math.hypot(apex[0] - V[0], apex[1] - V[1]) / half > miterLimit) return;
    rings.push([tx(o1[0], o1[1]), tx(apex[0], apex[1]), tx(o2[0], o2[1])]);
  }

  // Close an open end of `seg` (its p1 when `atStart`, else p2) per `cap`.
  _addCap(rings, tx, disc, seg, atStart, half, cap) {
    if (cap === 'butt') return;
    const P  = atStart ? seg.p1 : seg.p2;
    const ux = (atStart ? -seg.ux : seg.ux) * half;   // outward tangent * half
    const uy = (atStart ? -seg.uy : seg.uy) * half;
    if (cap === 'round') { rings.push(disc(P[0], P[1])); return; }
    // square: push the end face out by half a line-width along the tangent.
    const c1 = [P[0] + seg.nx, P[1] + seg.ny], c2 = [P[0] - seg.nx, P[1] - seg.ny];
    rings.push([tx(c1[0], c1[1]), tx(c1[0] + ux, c1[1] + uy),
                tx(c2[0] + ux, c2[1] + uy), tx(c2[0], c2[1])]);
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
    const sh = this._covShift;   // device translation (shadow rasterization); usually 0
    if (sh) { x0 += sh[0]; x1 += sh[0]; y0 += sh[1]; y1 += sh[1]; }
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
    const sh = this._covShift, shx = sh ? sh[0] : 0, shy = sh ? sh[1] : 0;   // device translation (shadow)
    let minY = Infinity, maxY = -Infinity;
    for (const ring of rings) for (const p of ring) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (!isFinite(minY)) return;
    const yStart = Math.max(0, Math.floor(minY + shy));
    const yEnd   = Math.min(ch - 1, Math.ceil(maxY + shy) - 1);
    const evenOdd = rule === 'evenodd';
    const S = 4, invS = 1 / S;
    let cov = this._covRow;
    if (!cov || cov.length < cw) cov = this._covRow = new globalThis.Float32Array(cw);
    const xs = [];
    for (let py = yStart; py <= yEnd; py++) {
      let tL = cw, tR = -1;
      for (let s = 0; s < S; s++) {
        const sy = py + (s + 0.5) * invS - shy;   // sample the un-shifted polygon
        xs.length = 0;
        for (const ring of rings) {
          const rn = ring.length;
          for (let i = 0; i < rn; i++) {
            const p1 = ring[i], p2 = ring[i + 1 === rn ? 0 : i + 1];
            const y1 = p1[1], y2 = p2[1];
            if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) {
              xs.push({x: shx + p1[0] + (sy - y1) / (y2 - y1) * (p2[0] - p1[0]), dir: y2 > y1 ? 1 : -1});
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
    // The backing holds values in this context's colour space; fill colours are
    // converted into it so getImageData reads them back correctly. A pattern's
    // source pixels carry their own colour space; a gradient's stops are sRGB.
    const dstCS = this._attrs.colorSpace;
    if (obj instanceof CanvasGradient || obj instanceof CanvasPattern) {
      const inv = invertMatrix(this._m);   // device → user space
      if (!inv) return null;
      const gradient = obj instanceof CanvasGradient;
      const srcCS = gradient ? 'srgb' : obj._colorSpace;
      const conv  = !!colourMatrix(srcCS, dstCS);
      // A pattern's tile is converted ONCE (not per sampled pixel) — sample from a
      // dest-space copy. A gradient interpolates sRGB stops, so its (rare, non-sRGB
      // context) samples convert per pixel.
      let sampObj = obj;
      if (conv && !gradient) {
        sampObj = new CanvasPattern(convertColorSpace(new globalThis.Uint8ClampedArray(obj._px), srcCS, dstCS), obj._w, obj._h, obj._rep, dstCS);
        sampObj._m = obj._m;
      }
      const sample = sampObj._sampler();    // user space → colour (gradient or tiled pattern)
      const convPer = conv && gradient;
      return (buf, i, px, py, cov) => {
        const dx = px + 0.5, dy = py + 0.5;
        let c = sample(inv[0] * dx + inv[2] * dy + inv[4], inv[1] * dx + inv[3] * dy + inv[5]);
        if (c) {
          if (convPer) c = convertPaintColor(c, srcCS, dstCS);
          compositePixel(buf, i, c, clamp01(c.a * ga * cov), op);
        }
      };
    }
    const paint = convertPaintColor(solid, 'srgb', dstCS);
    const a = clamp01(paint.a * ga);
    // A transparent solid is a no-op — except under a whole-canvas operator, where
    // even a transparent source clears the destination (copy/source-in/…).
    if (a <= 0 && !WHOLE_CANVAS_GCO.has(op)) return null;
    return (buf, i, px, py, cov) => compositePixel(buf, i, paint, cov >= 1 ? a : a * cov, op);
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
  // op's AA coverage). A whole-canvas compositing operator takes the pass that also
  // clears the uncovered destination.
  _paintWith(painter, enumerate, obj, solid) {
    if (!painter) return;
    // Painting with a tainted pattern (createPattern of a cross-origin source) taints this canvas
    // — covers fill / stroke / fillRect / strokeRect, which all sink here (fillText / strokeText
    // paint through their own glyph path and re-apply this check in _drawText).
    if (obj instanceof CanvasPattern && obj._tainted) this._originClean = false;
    // The cast shadow reflects the alpha the op actually deposits, so weight the AA
    // coverage by the source paint's own alpha (a translucent fill / a gradient stop
    // with alpha casts a proportionally lighter shadow). The shadow shape is
    // rasterized shifted by the offset, so sample the source at the un-shifted point.
    // The source-alpha sampler is built only when a shadow is active (off the common
    // no-shadow paint path).
    if (this._shadowActive()) {
      const srcAlpha = this._sourceAlphaFn(obj, solid);
      this._shadowPass(set => {
        const sh = this._covShift;   // the offset _shadowPass rasterizes the shape with
        enumerate((px, py, cov) => {
          const a = srcAlpha(px - sh[0], py - sh[1]);
          if (a > 0) set(px, py, cov * a);
        });
      });
    }
    if (WHOLE_CANVAS_GCO.has(this._gco)) this._paintWholeCanvas(painter, enumerate);
    else this._composite(painter, enumerate);
  }

  // Per-device-pixel alpha of a fill/stroke style (solid colour or gradient/pattern
  // sample), WITHOUT globalAlpha — the shadow pass applies that. Used to weight the
  // shadow's coverage by what the paint would actually deposit.
  _sourceAlphaFn(obj, solid) {
    if (obj instanceof CanvasGradient || obj instanceof CanvasPattern) {
      const inv = invertMatrix(this._m);
      if (!inv) return () => 0;
      const sample = obj._sampler();
      return (px, py) => {
        const dx = px + 0.5, dy = py + 0.5;
        const c = sample(inv[0] * dx + inv[2] * dy + inv[4], inv[1] * dx + inv[3] * dy + inv[5]);
        return c ? c.a : 0;
      };
    }
    return () => solid.a;
  }

  // Whole-canvas compositing (source-in/out, destination-in/atop, copy): these
  // operators define the result over the whole surface, so every pixel in the clip
  // region is touched — covered pixels blend under the operator, uncovered pixels
  // are cleared to transparent black.
  _paintWholeCanvas(painter, enumerate) {
    const buf = this._buffer();
    if (!buf) return;
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0, clip = this._clip, n = cw * ch;
    const cov = new globalThis.Float32Array(n);
    enumerate((px, py, c) => { const i = py * cw + px; if (c > cov[i]) cov[i] = c; });
    for (let i = 0; i < n; i++) {
      if (clip && !clip[i]) continue;
      const c = cov[i];
      if (c > 0) painter(buf, i * 4, i % cw, (i / cw) | 0, c);
      else { const b = i * 4; buf[b] = buf[b + 1] = buf[b + 2] = buf[b + 3] = 0; }
    }
  }

  // A shadow is cast when a blur or offset makes it visible (0 blur + 0 offset
  // would sit exactly under the shape) and shadowColor isn't fully transparent.
  // The cheap geometry check short-circuits before parsing the colour, keeping
  // the no-shadow paint path (the common case) allocation- and parse-free.
  _shadowActive() {
    if (this.shadowBlur <= 0 && this.shadowOffsetX === 0 && this.shadowOffsetY === 0) return false;
    return this._shadow.a > 0;
  }

  // Paint the shadow for a draw op: `rasterize(set)` reports the op's coverage
  // via set(px, py, coverage0to1); that alpha plane is Gaussian-blurred, tinted
  // with shadowColor, and composited under the actual draw (honoring the clip mask
  // + globalAlpha). The (shadowOffsetX, shadowOffsetY) translation is fed to the
  // coverage enumerators as `_covShift`, so the shadow shape is rasterized already
  // offset — a shape drawn off-canvas whose shadow lands on it (e.g. fillRect above
  // the top edge with a +Y offset) is captured, which post-emit clamping would drop.
  _shadowPass(rasterize) {
    const buf = this._buffer();
    if (!buf) return;
    const col = convertPaintColor(this._shadow, 'srgb', this._attrs.colorSpace);   // shadow colour → backing space
    if (col.a <= 0) return;
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    const cov = new globalThis.Float32Array(cw * ch);
    this._covShift = [Math.round(this.shadowOffsetX), Math.round(this.shadowOffsetY)];
    try {
      rasterize((px, py, c) => { const i = py * cw + px; if (c > cov[i]) cov[i] = c; });
    } finally {
      this._covShift = null;
    }
    const radius = Math.max(0, Math.round(this.shadowBlur / 2));
    const blurred = boxBlurAlpha(cov, cw, ch, radius);
    // Per the drawing model the shadow is composited with the current operator (then
    // the shape, also with it) — e.g. an 'xor' fill xors its own shadow. Default
    // source-over makes this identical to a plain blend for the common case. A
    // whole-canvas operator (copy / source-in / …) would need a surface-wide shadow
    // layer that also clears the uncovered destination, which we don't model — fall
    // back to source-over there (backlog).
    const clip = this._clip, ga = this.globalAlpha;
    const op = WHOLE_CANVAS_GCO.has(this._gco) ? 'source-over' : this._gco;
    for (let i = 0; i < blurred.length; i++) {
      const sc = blurred[i];
      if (sc <= 0) continue;
      if (clip && !clip[i]) continue;
      compositePixel(buf, i * 4, col, clamp01(col.a * ga * sc), op);
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
                                      emit => this._enumScanline(rings, rule, emit),
                                      this._fillObj, this._fill);
  }

  // stroke([path]): thicken the path into device-space rings (segment quads plus
  // lineCap / lineJoin geometry, split into the dash pattern's "on" pieces) and paint
  // the whole set in one nonzero pass — the union covers overlaps exactly once, so a
  // translucent strokeStyle doesn't darken at corners.
  stroke(path) {
    const rings = this._strokeRings(this.lineWidth,
                                    path instanceof CanvasPath ? path : this._pathObj);
    if (rings.length) this._paintWith(this._painter(this._strokeObj, this._stroke),
                                      emit => this._enumScanline(rings, 'nonzero', emit),
                                      this._strokeObj, this._stroke);
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
    if (!allFinite(x, y)) return false;
    // A non-invertible CTM maps the whole plane to a line/point — nothing has interior,
    // so no point is inside (matches fill() painting nothing), per spec.
    if (ctmSingular(this._m)) return false;
    // The point (x, y) is in canvas coordinate space — UNAFFECTED by the current
    // transform — so test it directly against the DEVICE-space path (where fill()
    // rasterizes). A Path2D's raw points are mapped through the CTM by _devicePath.
    // A point exactly on the fill boundary counts as inside (pointOnRingEdge).
    const rings = this._devicePath(path);
    return pointInRings(rings, x, y, rule === 'evenodd') || pointOnRingEdge(rings, x, y);
  }

  // isPointInStroke([path,] x, y) — is the point (in canvas coordinate space) on the
  // stroke? Tested against the ACTUAL stroke geometry — the same device-space rings
  // stroke() paints — so caps, joins, a non-uniform pen, and the dash pattern are all
  // honoured exactly (e.g. a point just past a butt-capped dash end is outside).
  isPointInStroke(a, b, c) {
    argc(arguments.length, 2);
    let path = this._pathObj, x, y;
    if (a instanceof CanvasPath) { path = a; x = +b; y = +c; } else { x = +a; y = +b; }
    if (!allFinite(x, y)) return false;
    // A non-invertible CTM collapses the stroke to zero area — nothing is on it. (For a
    // baked path _strokeRings already yields nothing under a singular CTM; a Path2D
    // argument is forward-mapped, so guard here too — symmetric with isPointInPath.)
    if (ctmSingular(this._m)) return false;
    const rings = this._strokeRings(this.lineWidth > 0 ? this.lineWidth : 1, path);
    return pointInRings(rings, x, y, false) || pointOnRingEdge(rings, x, y);
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
    const savedDash = this._lineDash;
    this._lineDash = [];
    let rings;
    try { rings = this._strokeRings(2, path, 'butt', 'miter', 10); }
    finally { this._lineDash = savedDash; }
    if (!rings.length) return;
    const ink = {r: 0, g: 0, b: 0, a: 1};   // opaque focus indicator
    this._composite(
      (buf, i, px, py, cov) => compositePixel(buf, i, ink, cov >= 1 ? 1 : cov, 'source-over'),
      emit => this._enumScanline(rings, 'nonzero', emit)
    );
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

  // Parse a CSS `font` shorthand and return its canonical serialized form (what the
  // `font` getter reports), or null if it doesn't parse. Output order is style, variant,
  // weight, stretch, size, family; `normal` in any slot and the default weight (400) are
  // dropped, the `/ line-height` is parsed and ignored, and the size is resolved to px
  // against the canvas element so `50%` / `1em` serialize as `<n>px` (spec: the font is
  // computed at assignment time).
  _serializeFont(input) {
    const CT = globalThis.__csimVendor && globalThis.__csimVendor.cssTree;
    const raw = String(input).trim();
    if (!raw || !CT) return null;
    let ast;
    try { ast = CT.parse(raw, {context: 'value'}); } catch (_) { return null; }
    const toks = [];
    ast.children.forEach(n => { if (n.type !== 'WhiteSpace') toks.push(n); });
    if (!toks.length) return null;
    // A lone system-font keyword resolves to the platform UI font; we don't model OS font
    // settings, so map every system keyword to one concrete default — enough that the
    // getter stops echoing the keyword (spec: it reports the used font).
    if (toks.length === 1 && toks[0].type === 'Identifier' && FONT_SYSTEM_KW.has(toks[0].name.toLowerCase())) {
      return '16px sans-serif';
    }

    let style = '', variant = '', weight = '', stretch = '', i = 0;
    // Optional style || variant || weight || stretch, any order, before the size.
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'Identifier') {
        const kw = t.name.toLowerCase();
        if (kw === 'normal') continue;                       // the default in every slot
        if (FONT_STYLE_KW.has(kw) && !style) {
          style = kw;
          const nxt = toks[i + 1];                           // `oblique <angle>`
          if (kw === 'oblique' && nxt && nxt.type === 'Dimension' && /^deg$/i.test(nxt.unit)) {
            style += ' ' + fmtCssNum(+nxt.value) + 'deg'; i++;
          }
          continue;
        }
        if (FONT_VARIANT_KW.has(kw) && !variant) { variant = kw; continue; }
        // Relative weights compute against the initial weight (normal = 400): bolder → 700
        // (bold), lighter → 100. Keep 'bold' as the keyword; drop the default 400.
        if (FONT_WEIGHT_KW.has(kw)  && !weight)  { weight = kw === 'lighter' ? '100' : 'bold'; continue; }
        if (FONT_STRETCH_KW.has(kw) && !stretch) { stretch = kw; continue; }
        break;                                               // not pre-size → size or family
      }
      if (t.type === 'Number' && !weight) {
        const w = +t.value;
        if (!(w >= 1 && w <= 1000)) return null;             // an invalid bare number here
        weight = w === 400 ? '' : fmtCssNum(w);
        continue;
      }
      break;                                                 // the size token
    }

    // Required <font-size>.
    const st = toks[i];
    if (!st) return null;
    let sizePx = null;
    if (st.type === 'Dimension')       sizePx = this._fontUnitToPx(+st.value, st.unit.toLowerCase());
    else if (st.type === 'Percentage') sizePx = +st.value / 100 * this._fontRelBase('%');
    else if (st.type === 'Identifier') sizePx = ABSOLUTE_FONT_SIZE_PX[st.name.toLowerCase()];
    if (sizePx == null || !(sizePx > 0) || !isFinite(sizePx)) return null;   // larger/smaller unsupported
    i++;

    // Optional `/ <line-height>`, parsed and dropped (canvas ignores it).
    if (toks[i] && toks[i].type === 'Operator' && toks[i].value === '/') i += 2;

    // <font-family> #: comma-separated, each a <string> or a run of identifiers. A lone
    // CSS-wide keyword ('inherit', 'initial', …) is not a valid family name.
    const families = [];
    let cur = null, curString = false;
    const flush = () => {
      if (cur == null || (!curString && CSS_WIDE_KW.has(cur.toLowerCase()))) return false;
      families.push(serializeFontFamily(cur, curString)); cur = null; curString = false;
      return true;
    };
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'Operator' && t.value === ',') {
        if (!flush()) return null;
      } else if (t.type === 'String') {
        if (cur != null) return null;
        cur = t.value; curString = true;
      } else if (t.type === 'Identifier') {
        cur = cur == null ? t.name : cur + ' ' + t.name;
      } else {
        return null;
      }
    }
    if (!flush()) return null;

    return [style, variant, weight, stretch, fmtCssNum(sizePx) + 'px', families.join(', ')].filter(Boolean).join(' ');
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

  // Render `text` to a coverage mask (real system-font glyphs via the host) and
  // composite it, honoring textAlign / textBaseline, translate + scale of the CTM,
  // the fill/stroke paint (solid or gradient), globalAlpha, and the clip mask.
  // Rotation/shear of the CTM positions the anchor but doesn't rotate the glyphs.
  _drawText(text, x, y, maxWidth, obj, solid) {
    // fillText / strokeText paint through their own glyph path (not _paintWith), so re-apply the
    // tainted-pattern check here: painting a cross-origin pattern as text glyphs must taint too.
    if (obj instanceof CanvasPattern && obj._tainted) this._originClean = false;
    text = String(text).replace(CANVAS_TEXT_WS, ' ');
    if (!text || !allFinite(x = +x, y = +y)) return;
    // A PROVIDED maxWidth that is ≤ 0 or NaN means "draw nothing" (spec), not "no
    // limit" — distinct from an omitted maxWidth (undefined), which is unconstrained.
    if (maxWidth !== undefined && !(+maxWidth > 0)) return;
    const buf = this._buffer();
    if (!buf || !globalThis.__csim_renderText) return;
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

    const cw = this.canvas.width | 0, ch = this.canvas.height | 0, clip = this._clip, ga = this.globalAlpha, op = this._gco;
    // Per-pixel paint scaled by glyph coverage: a gradient/pattern samples user
    // space, a solid colour composites directly.
    const dstCS = this._attrs.colorSpace;   // glyph colours land in the backing's space
    let paint;
    if (obj instanceof CanvasGradient || obj instanceof CanvasPattern) {
      const inv = invertMatrix(m);
      if (!inv) return;
      const sample = obj._sampler();
      const srcCS = (obj instanceof CanvasPattern) ? obj._colorSpace : 'srgb';
      const conv  = !!colourMatrix(srcCS, dstCS);
      paint = (i, px, py, cov) => {
        let c = sample(inv[0] * (px + 0.5) + inv[2] * (py + 0.5) + inv[4],
                       inv[1] * (px + 0.5) + inv[3] * (py + 0.5) + inv[5]);
        if (c) { if (conv) c = convertPaintColor(c, srcCS, dstCS); compositePixel(buf, i, c, clamp01(c.a * ga * cov), op); }
      };
    } else {
      const solidCS = convertPaintColor(solid, 'srgb', dstCS);
      if (clamp01(solidCS.a * ga) <= 0) return;
      paint = (i, px, py, cov) => compositePixel(buf, i, solidCS, clamp01(solidCS.a * ga * cov), op);
    }
    // Walk the placed glyph coverage, yielding cb(dx, dy, coverage0to1) per pixel
    // (no clip — consumers apply it). Shared by the shadow pass and the paint.
    const walk = cb => {
      const sh = this._covShift, shx = sh ? sh[0] : 0, shy = sh ? sh[1] : 0;   // shadow offset
      for (let my = 0; my < mhei; my++) {
        const dy = inkY + my + shy;
        if (dy < 0 || dy >= ch) continue;
        const maskRow = my * mwid;
        for (let ox = 0; ox < outW; ox++) {
          const mx = xScale === 1 ? ox : Math.min(mwid - 1, Math.floor(ox / xScale));
          const cov = mask[maskRow + mx];
          if (!cov) continue;
          const dx = inkX + ox + shx;
          if (dx < 0 || dx >= cw) continue;
          cb(dx, dy, cov / 255);
        }
      }
    };
    if (this._shadowActive()) {
      const srcAlpha = this._sourceAlphaFn(obj, solid);   // weight by the paint's alpha, like fill/stroke
      this._shadowPass(set => { const sh = this._covShift; walk((dx, dy, cov) => {
        const a = srcAlpha(dx - sh[0], dy - sh[1]);
        if (a > 0) set(dx, dy, cov * a);
      }); });
    }
    walk((dx, dy, cov) => {
      const idx = dy * cw + dx;
      if (clip && !clip[idx]) return;
      paint(idx * 4, dx, dy, cov);
    });
  }

  // The effective text direction: `ctx.direction` when explicit ('ltr'/'rtl'), otherwise
  // ('inherit') the canvas element's computed direction (its `dir` attribute / CSS).
  // The inherited case memoizes the getComputedStyle read per settle generation so a
  // steady draw loop of default start-aligned text doesn't re-run the cascade each call.
  _effectiveDirection() {
    const d = this._direction;
    if (d === 'ltr' || d === 'rtl') return d;
    // getComputedStyle(canvas).direction is cascade-derived, so key the memo on BOTH the
    // settle generation AND the cascade version — a deferred stylesheet / @media change
    // rebuilds the cascade without a DOM mutation, so settleGen alone would go stale.
    const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
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
    this._paintWith(this._painter(this._fillObj, this._fill), emit => this._enumRect(x, y, w, h, emit),
                    this._fillObj, this._fill);
  }

  clearRect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || !w || !h) return;
    // clearRect ignores fillStyle / globalAlpha and casts NO shadow — it clears
    // covered pixels (still honoring the clip mask), so it composites directly. A
    // partially-covered (AA) edge pixel is cleared proportionally (alpha scaled).
    this._composite((buf, i, px, py, cov) => {
      if (cov >= 1) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; }
      else { buf[i + 3] *= 1 - cov; }
    }, emit => this._enumRect(x, y, w, h, emit));
  }

  // strokeRect strokes the rectangle's closed path, so its four corners honor
  // lineJoin / miterLimit (rounded / bevelled / mitred) exactly like stroke() —
  // and a degenerate (zero-w/-h) rect strokes as the line it is. _strokeRings
  // unions the segment quads + joins in one nonzero pass, so overlaps never
  // double-composite under a translucent strokeStyle, and it composes through the
  // CTM (the stroke scales / rotates with the transform).
  strokeRect(x, y, w, h) {
    argc(arguments.length, 4);
    if (!allFinite(x = +x, y = +y, w = +w, h = +h) || (!w && !h)) return;
    const p = new CanvasPath(() => this._ctmScale());
    p.rect(x, y, w, h);
    const rings = this._strokeRings(this.lineWidth, p);
    if (rings.length) this._paintWith(this._painter(this._strokeObj, this._stroke),
                                      emit => this._enumScanline(rings, 'nonzero', emit),
                                      this._strokeObj, this._stroke);
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
    // Drawing a canvas onto itself: snapshot the source so overlapping copies read the
    // original pixels, not ones this draw has already written (self-aliasing).
    if (src.pixels === this.canvas._pixels) src = {pixels: src.pixels.slice(), width: src.width, height: src.height};
    // Bring the source into this canvas's colour space, so the backing store holds
    // context-space values (getImageData reads them back per its requested space). A
    // wide-gamut source drawn into an sRGB context is gamut-clipped here; into a P3
    // context it's preserved. Converts on a COPY so the source's pixels are untouched.
    let srcCS = sourceColorSpace(source);
    const ctxCS = this._attrs.colorSpace;
    // A wide-profile (Adobe/CMYK) source carries a separate Display-P3 rendering — use it
    // (not the clipped sRGB one) when drawing into a P3 canvas, so its wide colours survive.
    if (ctxCS === 'display-p3' && source._pixelsP3 && src.pixels === source._pixels) {
      src = { pixels: source._pixelsP3, width: src.width, height: src.height };
      srcCS = 'display-p3';
    }
    if (srcCS !== ctxCS) {
      src = { pixels: convertColorSpace(new globalThis.Uint8ClampedArray(src.pixels), srcCS, ctxCS), width: src.width, height: src.height };
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
    const cw = this.canvas.width | 0, ch = this.canvas.height | 0;
    if (!cw || !ch) return;
    if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
    // Draw through the per-pixel paint pipeline so the CTM (translate / scale /
    // rotation / shear), clip, globalAlpha, compositing operator, shadow, and
    // dest-mirroring are all honoured — and a transparent/semi-transparent source
    // composites (rather than overwriting, as a raw blit would). The 1:1, integer,
    // identity-transform case still resolves to the same nearest-neighbour pixels.
    this._paintImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // Draw an image sub-rect (sx,sy,sw,sh) into the user-space dest rect (dx,dy,dw,dh)
  // through the paint pipeline: the dest rect's device quad is rasterized, and each
  // covered device pixel samples the source (nearest-neighbour, sub-rect mirror for a
  // negative dw/dh) and composites under the current clip / alpha / operator / shadow.
  _paintImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const inv = invertMatrix(this._m);
    if (!inv) return;
    const painter = this._imagePainter(src, sx, sy, sw, sh, dx, dy, dw, dh);
    if (!painter) return;
    const quad = this._rectCorners(dx, dy, dw, dh);   // dest rect corners → device
    const rasterize = emit => this._enumScanline([quad], 'nonzero', emit);
    // Shadow: the cast coverage is the drawn SOURCE alpha (a transparent source
    // casts no shadow), so weight the geometric coverage by the sampled source
    // alpha rather than shadowing the whole dest quad.
    if (this._shadowActive()) {
      const pixels = src.pixels, iw = src.width, ih = src.height, fx = sw / dw, fy = sh / dh;
      // The shadow quad is rasterized already shifted by the offset (_covShift), so a
      // covered device pixel (px,py) maps back to the source at the UN-shifted position.
      this._shadowPass(set => { const sh2 = this._covShift; rasterize((px, py, cov) => {
        const ox = px - sh2[0] + 0.5, oy = py - sh2[1] + 0.5;
        const ux = inv[0] * ox + inv[2] * oy + inv[4];
        const uy = inv[1] * ox + inv[3] * oy + inv[5];
        const spx = Math.floor(sx + (ux - dx) * fx), spy = Math.floor(sy + (uy - dy) * fy);
        if (spx < 0 || spy < 0 || spx >= iw || spy >= ih) return;
        const sa = pixels[(spy * iw + spx) * 4 + 3] / 255;
        if (sa > 0) set(px, py, sa * cov);
      }); });
    }
    if (WHOLE_CANVAS_GCO.has(this._gco)) this._paintWholeCanvas(painter, rasterize);
    else this._composite(painter, rasterize);
  }

  _imagePainter(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const ga = this.globalAlpha, op = this._gco;
    const inv = invertMatrix(this._m);   // device → user space
    if (!inv) return null;
    const pixels = src.pixels, iw = src.width, ih = src.height;
    const fx = sw / dw, fy = sh / dh;    // user (dest) → source scale (negative = mirror)
    const col = {r: 0, g: 0, b: 0};      // reused scratch (compositePixel reads r/g/b + the alpha arg)
    const whole = WHOLE_CANVAS_GCO.has(op);   // loop-invariant: op never changes across the paint
    // Bilinear resampling applies only when smoothing is on AND the source is
    // actually scaled or rotated on the way to device space — a pixel-aligned 1:1
    // (or mirror-only) blit resolves to the same samples either way, so the
    // cheaper nearest path stays the default. The scale can come from the drawImage
    // dest rect (sw/dw) OR the CTM (ctx.scale), so measure the source rect's final
    // device extent, not just fx/fy. The hypots sit behind the enabled/rotation
    // short-circuit so the smoothing-off path pays nothing.
    const m = this._m;
    const smooth = this.imageSmoothingEnabled && (
      m[1] !== 0 || m[2] !== 0 ||                                             // rotation / shear
      Math.abs(Math.abs(dw) * Math.hypot(m[0], m[1]) - Math.abs(sw)) > 1e-3 ||  // x magnify / minify
      Math.abs(Math.abs(dh) * Math.hypot(m[2], m[3]) - Math.abs(sh)) > 1e-3);   // y magnify / minify
    if (smooth) {
      // Clamp bilinear neighbours to the SOURCE sub-rect, not the whole image, so
      // drawing one cell of a sprite atlas doesn't bleed the adjacent cell's pixels
      // in at the seam (browsers clamp sampling to the source rectangle edges). For a
      // full-image draw this collapses to the image bounds, so it's a no-op there.
      const rxa = Math.min(sx, sx + sw), rxb = Math.max(sx, sx + sw);
      const rya = Math.min(sy, sy + sh), ryb = Math.max(sy, sy + sh);
      const minX = Math.max(0, Math.floor(rxa)), maxX = Math.min(iw - 1, Math.ceil(rxb) - 1);
      const minY = Math.max(0, Math.floor(rya)), maxY = Math.min(ih - 1, Math.ceil(ryb) - 1);
      return (buf, i, px, py, cov) => {
        const ux = inv[0] * (px + 0.5) + inv[2] * (py + 0.5) + inv[4];
        const uy = inv[1] * (px + 0.5) + inv[3] * (py + 0.5) + inv[5];
        // Sample the source at the pixel centre and interpolate the four
        // neighbours, weighting in premultiplied space so partially-transparent
        // edges don't bleed the wrong colour.
        const gx = sx + (ux - dx) * fx - 0.5, gy = sy + (uy - dy) * fy - 0.5;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const tx = gx - x0, ty = gy - y0, itx = 1 - tx, ity = 1 - ty;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
          const w = ((k & 1) ? tx : itx) * ((k >> 1) ? ty : ity);
          if (w <= 0) continue;
          let nx = x0 + (k & 1), ny = y0 + (k >> 1);
          if (nx < minX) nx = minX; else if (nx > maxX) nx = maxX;
          if (ny < minY) ny = minY; else if (ny > maxY) ny = maxY;
          const j = (ny * iw + nx) * 4, na = pixels[j + 3] / 255;
          r += pixels[j]     * na * w;
          g += pixels[j + 1] * na * w;
          b += pixels[j + 2] * na * w;
          a += na * w;
        }
        if (a <= 0 && !whole) return;
        // Un-premultiply back to straight RGBA for the compositor.
        col.r = a > 0 ? r / a : 0;
        col.g = a > 0 ? g / a : 0;
        col.b = a > 0 ? b / a : 0;
        compositePixel(buf, i, col, clamp01(a * ga * cov), op);
      };
    }
    return (buf, i, px, py, cov) => {
      const ux = inv[0] * (px + 0.5) + inv[2] * (py + 0.5) + inv[4];
      const uy = inv[1] * (px + 0.5) + inv[3] * (py + 0.5) + inv[5];
      const spx = Math.floor(sx + (ux - dx) * fx);   // nearest source pixel
      const spy = Math.floor(sy + (uy - dy) * fy);
      // Outside the image samples as transparent black. For an ordinary operator a
      // transparent source contributes nothing (skip); a whole-canvas operator must
      // still composite it (copy/source-in/… clear the destination there).
      const inside = spx >= 0 && spy >= 0 && spx < iw && spy < ih;
      const si = inside ? (spy * iw + spx) * 4 : -1;
      const sa = inside ? pixels[si + 3] / 255 : 0;
      if (sa <= 0 && !whole) return;
      col.r = inside ? pixels[si]     : 0;
      col.g = inside ? pixels[si + 1] : 0;
      col.b = inside ? pixels[si + 2] : 0;
      compositePixel(buf, i, col, clamp01(sa * ga * cov), op);
    };
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
