// The 2D canvas's rasterizer (HTML §4.12.5.1): what one drawing operation does to a canvas's bitmap. The shape it
// covers — a device box, polygon rings under a winding rule, or a glyph mask — gives each pixel an anti-aliased
// coverage; the paint (a solid colour, a gradient, a pattern, an image, or clearRect's clearing) gives it a colour; the
// compositing operator lays that over what is there, inside the clip mask, a shadow cast first where one is set (§4.12.5.1.17,
// the drawing model). And the colour spaces a bitmap can hold (sRGB / Display P3), converted between.
//
use std::borrow::Cow;

use crate::canvas_path::{invert, Path, Pen, Ring};

// The bitmap is the page's own `Uint8ClampedArray`, written in place; every value lands in it as that array stores one
// (clamped, rounded half to even), and the coverage planes are `f32`, as the arrays that used to hold them were.

// The compositing operators (Compositing and Blending 1): Porter–Duff, `lighter`, and the separable blend modes;
// the non-separable ones (hue / saturation / color / luminosity) composite as source-over.
#[derive(Clone, Copy)]
enum Op {
    SourceOver,
    SourceIn,
    SourceOut,
    SourceAtop,
    DestinationOver,
    DestinationIn,
    DestinationOut,
    DestinationAtop,
    Copy,
    Xor,
    Lighter,
    Clear,
    Blend(fn(f64, f64) -> f64),
}

impl Op {
    fn parse(name: &str) -> Op {
        match name {
            "source-in" => Op::SourceIn,
            "source-out" => Op::SourceOut,
            "source-atop" => Op::SourceAtop,
            "destination-over" => Op::DestinationOver,
            "destination-in" => Op::DestinationIn,
            "destination-out" => Op::DestinationOut,
            "destination-atop" => Op::DestinationAtop,
            "copy" => Op::Copy,
            "xor" => Op::Xor,
            "lighter" | "plus-lighter" => Op::Lighter,
            "clear" => Op::Clear,
            "multiply" => Op::Blend(|b, s| b * s),
            "screen" => Op::Blend(|b, s| b + s - b * s),
            "overlay" => Op::Blend(|b, s| if b <= 0.5 { 2.0 * b * s } else { 1.0 - 2.0 * (1.0 - b) * (1.0 - s) }),
            "darken" => Op::Blend(f64::min),
            "lighten" => Op::Blend(f64::max),
            "color-dodge" => Op::Blend(|b, s| {
                if b == 0.0 {
                    0.0
                } else if s >= 1.0 {
                    1.0
                } else {
                    (b / (1.0 - s)).min(1.0)
                }
            }),
            "color-burn" => Op::Blend(|b, s| {
                if b >= 1.0 {
                    1.0
                } else if s <= 0.0 {
                    0.0
                } else {
                    1.0 - ((1.0 - b) / s).min(1.0)
                }
            }),
            "hard-light" => Op::Blend(|b, s| if s <= 0.5 { 2.0 * s * b } else { 1.0 - 2.0 * (1.0 - s) * (1.0 - b) }),
            "soft-light" => Op::Blend(|b, s| {
                if s <= 0.5 {
                    return b - (1.0 - 2.0 * s) * b * (1.0 - b);
                }
                let d = if b <= 0.25 { ((16.0 * b - 12.0) * b + 4.0) * b } else { b.sqrt() };
                b + (2.0 * s - 1.0) * (d - b)
            }),
            "difference" => Op::Blend(|b, s| (b - s).abs()),
            "exclusion" => Op::Blend(|b, s| b + s - 2.0 * b * s),
            _ => Op::SourceOver,
        }
    }
    // An operator that defines the result over the WHOLE bitmap: the destination no source covers is cleared too.
    // (`clear`, like `xor`, touches only what the source covers.)
    fn whole_canvas(self) -> bool {
        matches!(self, Op::SourceIn | Op::SourceOut | Op::DestinationIn | Op::DestinationAtop | Op::Copy)
    }
}

// A colour: straight `r`, `g`, `b` on the byte scale (not necessarily whole), the alpha apart.
#[derive(Clone, Copy)]
struct Rgb {
    r: f64,
    g: f64,
    b: f64,
}

// Each byte as a fraction of 255 — the same quotient a division gives, without one per channel per pixel.
static UNIT: [f64; 256] = {
    let mut t = [0.0; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = i as f64 / 255.0;
        i += 1;
    }
    t
};
fn unit(b: u8) -> f64 {
    UNIT[b as usize]
}

// A value as a `Uint8ClampedArray` stores it: clamped to 0–255 and rounded half to even, NaN as 0.
fn byte(v: f64) -> u8 {
    if v.is_nan() || v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round_ties_even() as u8
    }
}
// JS `Math.round`: half rounds up.
fn js_round(v: f64) -> f64 {
    floor(v + 0.5)
}
// `f64::floor`, inlined: without SSE4.1 the standard one is a call into libm, once per sampled pixel.
#[inline]
fn floor(x: f64) -> f64 {
    // (…past 2⁵² every f64 is whole, and NaN is its own floor)
    if !(x.abs() < 4_503_599_627_370_496.0) {
        return x;
    }
    let t = x as i64 as f64;
    if t > x { t - 1.0 } else { t }
}
fn clamp01(a: f64) -> f64 {
    a.clamp(0.0, 1.0)
}

// Composite `col` at alpha `a` onto the pixel at byte offset `i` under `op`, straight alpha in and out.
fn composite(buf: &mut [u8], i: usize, col: Rgb, a: f64, op: Op) {
    let px = &mut buf[i..i + 4];
    if matches!(op, Op::SourceOver) {
        if a >= 1.0 {
            px.copy_from_slice(&[byte(col.r), byte(col.g), byte(col.b), 255]);
            return;
        }
        let da = unit(px[3]);
        let out_a = a + da * (1.0 - a);
        if out_a <= 0.0 {
            px.fill(0);
            return;
        }
        let keep = da * (1.0 - a);
        px[0] = byte((col.r * a + f64::from(px[0]) * keep) / out_a);
        px[1] = byte((col.g * a + f64::from(px[1]) * keep) / out_a);
        px[2] = byte((col.b * a + f64::from(px[2]) * keep) / out_a);
        px[3] = byte(out_a * 255.0);
        return;
    }
    let (as_, ab) = (a, unit(px[3]));
    let (sr, sg, sb) = (col.r / 255.0, col.g / 255.0, col.b / 255.0);
    let (dr, dg, db) = (unit(px[0]), unit(px[1]), unit(px[2]));
    let (ao, pr, pg, pb);
    match op {
        Op::Blend(blend) => {
            ao = as_ + ab * (1.0 - as_);
            let (c0, c1, c2) = ((1.0 - ab) * as_, (1.0 - as_) * ab, as_ * ab);
            pr = c0 * sr + c1 * dr + c2 * blend(dr, sr);
            pg = c0 * sg + c1 * dg + c2 * blend(dg, sg);
            pb = c0 * sb + c1 * db + c2 * blend(db, sb);
        }
        Op::Lighter => {
            ao = (as_ + ab).min(1.0);
            pr = as_ * sr + ab * dr;
            pg = as_ * sg + ab * dg;
            pb = as_ * sb + ab * db;
        }
        _ => {
            // The Porter–Duff factors; a whole-canvas operator's clearing of what the source does not cover is the
            // caller's, this is the covered pixel's blend.
            let (fa, fb) = match op {
                Op::DestinationOver => (1.0 - ab, 1.0),
                Op::DestinationOut => (0.0, 1.0 - as_),
                Op::SourceAtop => (ab, 1.0 - as_),
                Op::Xor => (1.0 - ab, 1.0 - as_),
                Op::SourceIn => (ab, 0.0),
                Op::SourceOut => (1.0 - ab, 0.0),
                Op::DestinationIn => (0.0, as_),
                Op::DestinationAtop => (1.0 - ab, as_),
                Op::Copy => (1.0, 0.0),
                Op::Clear => (0.0, 0.0),
                _ => (1.0, 1.0 - as_),
            };
            ao = as_ * fa + ab * fb;
            pr = as_ * fa * sr + ab * fb * dr;
            pg = as_ * fa * sg + ab * fb * dg;
            pb = as_ * fa * sb + ab * fb * db;
        }
    }
    if ao <= 0.0 {
        px.fill(0);
        return;
    }
    px.copy_from_slice(&[byte(pr / ao * 255.0), byte(pg / ao * 255.0), byte(pb / ao * 255.0), byte(ao * 255.0)]);
}

// ── colour spaces ──
// sRGB and Display P3 share sRGB's transfer function, so a conversion is: expand, a 3×3 matrix on linear RGB (D65),
// compress. A P3 colour outside sRGB's gamut is clipped into it, as a browser reads a wide colour back as sRGB.
const SRGB_TO_P3: [f64; 9] = [0.82246197, 0.17753803, 0.0, 0.03319420, 0.96680580, 0.0, 0.01708263, 0.07239744, 0.91051993];
const P3_TO_SRGB: [f64; 9] = [1.22494018, -0.22494018, 0.0, -0.04205695, 1.04205695, 0.0, -0.01963755, -0.07863605, 1.09827360];
fn eotf(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn oetf(c: f64) -> f64 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}
// The matrix from one space to the other (`p3` naming each side), None where they are the same.
fn matrix(from_p3: bool, to_p3: bool) -> Option<&'static [f64; 9]> {
    match (from_p3, to_p3) {
        (false, true) => Some(&SRGB_TO_P3),
        (true, false) => Some(&P3_TO_SRGB),
        _ => None,
    }
}
// Whole bytes converted by `m`.
fn convert_bytes(m: &[f64; 9], r: u8, g: u8, b: u8) -> [f64; 3] {
    let (r, g, b) = (eotf(unit(r)), eotf(unit(g)), eotf(unit(b)));
    let lin = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
    lin.map(|c| js_round(oetf(clamp01(c)) * 255.0))
}
fn convert_rgb(m: Option<&[f64; 9]>, c: Rgb) -> Rgb {
    let Some(m) = m else { return c };
    let [r, g, b] = convert_bytes(m, byte(c.r), byte(c.g), byte(c.b));
    Rgb { r, g, b }
}
// An RGBA buffer converted in place.
fn convert_buffer(m: &[f64; 9], data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let [r, g, b] = convert_bytes(m, px[0], px[1], px[2]);
        px[0] = byte(r);
        px[1] = byte(g);
        px[2] = byte(b);
    }
}

// ── the affine matrix ──
type Matrix = [f64; 6];
fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

// A buffer an operation needs that cannot be had — a page's own size asked for one it cannot get (a canvas
// 2147483647 wide): the op throws a RangeError, as the typed array that held it used to, rather than abort.
#[derive(Debug)]
pub(crate) struct Oom;
fn zeroed<T: Copy>(n: usize, v: T) -> Result<Vec<T>, Oom> {
    let mut out = Vec::new();
    out.try_reserve_exact(n).map_err(|_| Oom)?;
    out.resize(n, v);
    Ok(out)
}

// ── the shape: each covered pixel and its coverage ──
enum Shape<'a> {
    // A device box, its edges anti-aliased by area.
    Box([f64; 4]),
    // Polygon rings, under nonzero or (`even_odd`) the even-odd rule.
    Rings { rings: Vec<Ring>, even_odd: bool },
    // A glyph mask (`w` × `h` coverage bytes) placed at (`x`, `y`).
    Mask { mask: &'a [u8], w: usize, h: usize, x: i64, y: i64 },
}

impl Shape<'_> {
    // Call `emit(px, py, coverage)` for each pixel of a `cw` × `ch` bitmap the shape covers, coverage in (0, 1], the
    // shape moved by `shift` device pixels (a shadow's offset).
    fn cover(&self, cw: usize, ch: usize, shift: (f64, f64), emit: &mut dyn FnMut(usize, usize, f64)) -> Result<(), Oom> {
        if cw == 0 || ch == 0 {
            return Ok(());
        }
        match self {
            Shape::Box(b) => cover_box(*b, cw, ch, shift, emit),
            Shape::Rings { rings, even_odd } => return cover_rings(rings, *even_odd, cw, ch, shift, emit),
            &Shape::Mask { mask, w, h, x, y } => {
                let (sx, sy) = (shift.0 as i64, shift.1 as i64);
                for my in 0..h {
                    let dy = y + my as i64 + sy;
                    if dy < 0 || dy >= ch as i64 {
                        continue;
                    }
                    for mx in 0..w {
                        let cov = mask[my * w + mx];
                        if cov == 0 {
                            continue;
                        }
                        let dx = x + mx as i64 + sx;
                        if dx < 0 || dx >= cw as i64 {
                            continue;
                        }
                        emit(dx as usize, dy as usize, unit(cov));
                    }
                }
            }
        }
        Ok(())
    }
}

// Each pixel's coverage is its area of overlap with the box: a fractional edge anti-aliased, an integer-aligned box
// whole pixels.
fn cover_box(b: [f64; 4], cw: usize, ch: usize, shift: (f64, f64), emit: &mut dyn FnMut(usize, usize, f64)) {
    let (mut x0, mut y0, mut x1, mut y1) = (b[0] + shift.0, b[1] + shift.1, b[2] + shift.0, b[3] + shift.1);
    // (…a box with no finite edge covers nothing — `f64::max` would take a NaN edge for the canvas's)
    if ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) {
        return;
    }
    if x1 < x0 {
        std::mem::swap(&mut x0, &mut x1);
    }
    if y1 < y0 {
        std::mem::swap(&mut y0, &mut y1);
    }
    let (xl, xr) = (x0.floor().max(0.0), (x1.ceil() - 1.0).min(cw as f64 - 1.0));
    let (yt, yb) = (y0.floor().max(0.0), (y1.ceil() - 1.0).min(ch as f64 - 1.0));
    if !(xl <= xr && yt <= yb) {
        return;
    }
    for py in yt as usize..=yb as usize {
        let p = py as f64;
        let oy = (p + 1.0).min(y1) - p.max(y0);
        if oy <= 0.0 {
            continue;
        }
        for px in xl as usize..=xr as usize {
            let q = px as f64;
            let ox = (q + 1.0).min(x1) - q.max(x0);
            if ox > 0.0 {
                emit(px, py, (ox * oy).min(1.0));
            }
        }
    }
}

// Rings filled by scanline: each pixel row sampled at four sub-scanlines, each covered span adding its exact
// horizontal overlap into the row's coverage. Nonzero merges each region of nonzero winding (overlapping pieces of a
// stroke cover a pixel once); even-odd alternates.
pub(crate) fn cover_rings(rings: &[Ring], even_odd: bool, cw: usize, ch: usize, shift: (f64, f64), emit: &mut dyn FnMut(usize, usize, f64)) -> Result<(), Oom> {
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    for &(_, y) in rings.iter().flatten() {
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    if !min_y.is_finite() || !max_y.is_finite() {
        return Ok(());
    }
    let y_start = (min_y + shift.1).floor().max(0.0);
    let y_end = ((max_y + shift.1).ceil() - 1.0).min(ch as f64 - 1.0);
    if y_start > y_end {
        return Ok(());
    }
    const S: usize = 4;
    let inv_s = 1.0 / S as f64;
    let mut cov = zeroed(cw, 0f32)?;
    let mut xs: Vec<(f64, i32)> = Vec::new();
    for py in y_start as usize..=y_end as usize {
        let (mut lo, mut hi) = (cw, None::<usize>);
        let mut span = |cov: &mut [f32], xa: f64, xb: f64| {
            if let Some((first, last)) = add_span(cov, xa, xb, inv_s, cw) {
                lo = lo.min(first);
                hi = Some(hi.map_or(last, |h| h.max(last)));
            }
        };
        for s in 0..S {
            let sy = py as f64 + (s as f64 + 0.5) * inv_s - shift.1;
            xs.clear();
            for ring in rings {
                let n = ring.len();
                for i in 0..n {
                    let (p1, p2) = (ring[i], ring[(i + 1) % n]);
                    if (p1.1 <= sy && p2.1 > sy) || (p2.1 <= sy && p1.1 > sy) {
                        xs.push((shift.0 + p1.0 + (sy - p1.1) / (p2.1 - p1.1) * (p2.0 - p1.0), if p2.1 > p1.1 { 1 } else { -1 }));
                    }
                }
            }
            if xs.len() < 2 {
                continue;
            }
            xs.sort_by(|a, b| a.0.total_cmp(&b.0));
            if even_odd {
                for pair in xs.chunks_exact(2) {
                    span(&mut cov, pair[0].0, pair[1].0);
                }
            } else {
                let (mut w, mut start) = (0, 0.0);
                for &(x, dir) in &xs {
                    let prev = w;
                    w += dir;
                    if prev == 0 && w != 0 {
                        start = x;
                    } else if prev != 0 && w == 0 {
                        span(&mut cov, start, x);
                    }
                }
            }
        }
        let Some(hi) = hi else { continue };
        for px in lo..=hi {
            let c = f64::from(cov[px]);
            if c > 0.0 {
                emit(px, py, c.min(1.0));
                cov[px] = 0.0;
            }
        }
    }
    Ok(())
}
// Add the span [xa, xb) at weight `w` into a coverage row: the pixels it touches, or None for none.
fn add_span(cov: &mut [f32], xa: f64, xb: f64, w: f64, cw: usize) -> Option<(usize, usize)> {
    if xa.is_nan() || xb.is_nan() {
        return None;
    }
    let (xa, xb) = (xa.max(0.0), xb.min(cw as f64));
    if xb <= xa {
        return None;
    }
    let (first, last) = (xa.floor() as usize, (xb.ceil() - 1.0) as usize);
    for px in first..=last {
        let p = px as f64;
        let (l, r) = (xa.max(p), xb.min(p + 1.0));
        if r > l {
            cov[px] = (f64::from(cov[px]) + (r - l) * w) as f32;
        }
    }
    Some((first, last))
}

// ── the paint ──
struct Stop {
    offset: f64,
    r: f64,
    g: f64,
    b: f64,
    a: f64,
}
enum Gradient {
    Linear { x0: f64, y0: f64, dx: f64, dy: f64, len2: f64 },
    Radial { x0: f64, y0: f64, r0: f64, dcx: f64, dcy: f64, dr: f64, a: f64 },
    Conic { a0: f64, x: f64, y: f64 },
}

enum Paint<'a> {
    Solid { col: Rgb, a: f64 },
    // clearRect: what it covers cleared, an edge in proportion.
    Clear,
    // A gradient: its stops, sorted; its colours are sRGB, converted by `to` per sample.
    Gradient { kind: Gradient, stops: Vec<Stop>, to: Option<&'static [f64; 9]> },
    // A pattern's tile, in the bitmap's space already, tiled on the axes it repeats; sampled through `inv` (its own
    // transform, inverted).
    Pattern { px: Cow<'a, [u8]>, w: usize, h: usize, rep_x: bool, rep_y: bool, inv: Matrix },
    // drawImage: the image's (sx, sy, sw, sh) drawn into the user-space rectangle (dx, dy, dw, dh) — nearest, or with
    // `smooth`, bilinear within the source rectangle (`clamp`: its pixel bounds).
    Image(Image<'a>),
}

struct Image<'a> {
    px: Cow<'a, [u8]>,
    iw: usize,
    ih: usize,
    src: [f64; 4],
    dst: [f64; 4],
    // The source pixels per user-space unit, each axis (negative: mirrored).
    scale: (f64, f64),
    smooth: bool,
    clamp: [i64; 4],
}

impl Image<'_> {
    // The source point a user-space point samples.
    fn source(&self, ux: f64, uy: f64) -> (f64, f64) {
        (self.src[0] + (ux - self.dst[0]) * self.scale.0, self.src[1] + (uy - self.dst[1]) * self.scale.1)
    }
    // The byte offset of the source's nearest pixel to the user-space point, None outside it.
    fn nearest(&self, ux: f64, uy: f64) -> Option<usize> {
        let (sx, sy) = self.source(ux, uy);
        let (sx, sy) = (floor(sx), floor(sy));
        (sx >= 0.0 && sy >= 0.0 && sx < self.iw as f64 && sy < self.ih as f64).then(|| (sy as usize * self.iw + sx as usize) * 4)
    }
    // The colour and alpha at the user-space point; `whole` as `Paint::sample`.
    fn sample(&self, ux: f64, uy: f64, whole: bool) -> Option<(Rgb, f64)> {
        let px = &self.px;
        if !self.smooth {
            return match self.nearest(ux, uy) {
                Some(j) if px[j + 3] > 0 => {
                    Some((Rgb { r: f64::from(px[j]), g: f64::from(px[j + 1]), b: f64::from(px[j + 2]) }, unit(px[j + 3])))
                }
                _ if whole => Some((Rgb { r: 0.0, g: 0.0, b: 0.0 }, 0.0)),
                _ => None,
            };
        }
        // The four pixels around the point, weighted by their nearness and premultiplied, so a transparent one
        // does not bleed its colour in.
        let (gx, gy) = self.source(ux, uy);
        let (gx, gy) = (gx - 0.5, gy - 0.5);
        let (fx, fy) = (floor(gx), floor(gy));
        let (tx, ty) = (gx - fx, gy - fy);
        let (x0, y0) = (fx as i64, fy as i64);
        // (…held inside the source rectangle — where that lies wholly off the image, there is nothing to draw)
        let c = &self.clamp;
        if c[0] > c[1] || c[2] > c[3] {
            return whole.then_some((Rgb { r: 0.0, g: 0.0, b: 0.0 }, 0.0));
        }
        let held = |v: i64, lo: i64, hi: i64| v.clamp(lo, hi) as usize;
        let xs = [held(x0, c[0], c[1]), held(x0 + 1, c[0], c[1])];
        let ys = [held(y0, c[2], c[3]), held(y0 + 1, c[2], c[3])];
        let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 0.0);
        for k in 0..4 {
            let w = (if k & 1 == 1 { tx } else { 1.0 - tx }) * (if k >> 1 == 1 { ty } else { 1.0 - ty });
            if w <= 0.0 {
                continue;
            }
            let j = (ys[k >> 1] * self.iw + xs[k & 1]) * 4;
            let na = unit(px[j + 3]);
            r += f64::from(px[j]) * na * w;
            g += f64::from(px[j + 1]) * na * w;
            b += f64::from(px[j + 2]) * na * w;
            a += na * w;
        }
        if a <= 0.0 && !whole {
            return None;
        }
        let un = |c: f64| if a > 0.0 { c / a } else { 0.0 };
        Some((Rgb { r: un(r), g: un(g), b: un(b) }, a))
    }
}

impl Paint<'_> {
    // Whether the paint needs the user-space point of a pixel (the CTM inverted).
    fn sampled(&self) -> bool {
        !matches!(self, Paint::Solid { .. } | Paint::Clear)
    }

    // The colour and alpha the paint gives the user-space point (ux, uy) — None where it gives none (outside a
    // pattern that does not repeat, a degenerate gradient). `whole`: an image gives transparent black outside itself,
    // which a whole-canvas operator still composites.
    fn sample(&self, ux: f64, uy: f64, whole: bool) -> Option<(Rgb, f64)> {
        match self {
            Paint::Solid { col, a } => Some((*col, *a)),
            Paint::Clear => None,
            Paint::Gradient { kind, stops, to } => {
                let t = gradient_t(kind, ux, uy)?;
                let (c, a) = stop_colour(stops, t);
                Some((convert_rgb(*to, c), a))
            }
            &Paint::Pattern { ref px, w, h, rep_x, rep_y, inv } => {
                let (x, y) = apply(&inv, ux, uy);
                let (ix, iy) = (floor(x), floor(y));
                let ix = if rep_x { ix.rem_euclid(w as f64) } else if ix < 0.0 || ix >= w as f64 { return None } else { ix };
                let iy = if rep_y { iy.rem_euclid(h as f64) } else if iy < 0.0 || iy >= h as f64 { return None } else { iy };
                let i = (iy as usize * w + ix as usize) * 4;
                Some((Rgb { r: f64::from(px[i]), g: f64::from(px[i + 1]), b: f64::from(px[i + 2]) }, unit(px[i + 3])))
            }
            Paint::Image(image) => image.sample(ux, uy, whole),
        }
    }

    // The alpha the paint deposits at (ux, uy) before `globalAlpha`, which weights the shadow it casts: an image's
    // nearest source pixel's even where it draws smoothed.
    fn shadow_alpha(&self, ux: f64, uy: f64) -> f64 {
        match self {
            Paint::Image(image) => image.nearest(ux, uy).map_or(0.0, |j| unit(image.px[j + 3])),
            _ => self.sample(ux, uy, false).map_or(0.0, |(_, a)| a),
        }
    }
}
// A gradient's parameter at the user-space point, None where it paints nothing there.
fn gradient_t(kind: &Gradient, ux: f64, uy: f64) -> Option<f64> {
    match *kind {
        Gradient::Linear { x0, y0, dx, dy, len2 } => Some(((ux - x0) * dx + (uy - y0) * dy) / len2),
        Gradient::Conic { a0, x, y } => {
            let tau = std::f64::consts::TAU;
            let mut ang = ((uy - y).atan2(ux - x) - a0) % tau;
            if ang < 0.0 {
                ang += tau;
            }
            Some(ang / tau)
        }
        // The largest ω that puts the point on the circle interpolated from the start circle to the end one, with a
        // radius ≥ 0 (§4.12.5.1.9).
        Gradient::Radial { x0, y0, r0, dcx, dcy, dr, a } => {
            let (px, py) = (ux - x0, uy - y0);
            let b = 2.0 * (px * dcx + py * dcy + r0 * dr);
            let c = px * px + py * py - r0 * r0;
            if a.abs() < 1e-9 {
                if b == 0.0 {
                    return None;
                }
                let omega = c / b;
                return (r0 + omega * dr >= 0.0).then_some(omega);
            }
            let disc = b * b - 4.0 * a * c;
            if disc < 0.0 {
                return None;
            }
            let sq = disc.sqrt();
            let (p, q) = ((b + sq) / (2.0 * a), (b - sq) / (2.0 * a));
            let (hi, lo) = (p.max(q), p.min(q));
            if r0 + hi * dr >= 0.0 {
                Some(hi)
            } else if r0 + lo * dr >= 0.0 {
                Some(lo)
            } else {
                None
            }
        }
    }
}
// The colour at `t`: interpolated between the stops around it, the end stops' outside them.
fn stop_colour(stops: &[Stop], t: f64) -> (Rgb, f64) {
    let own = |s: &Stop| (Rgb { r: s.r, g: s.g, b: s.b }, s.a);
    let (first, last) = (&stops[0], &stops[stops.len() - 1]);
    if t <= first.offset {
        return own(first);
    }
    if t >= last.offset {
        return own(last);
    }
    for pair in stops.windows(2) {
        let (p, q) = (&pair[0], &pair[1]);
        if t <= q.offset {
            let span = q.offset - p.offset;
            let f = (t - p.offset) / if span == 0.0 { 1.0 } else { span };
            let lerp = |a: f64, b: f64| js_round(a + (b - a) * f);
            return (Rgb { r: lerp(p.r, q.r), g: lerp(p.g, q.g), b: lerp(p.b, q.b) }, p.a + (q.a - p.a) * f);
        }
    }
    own(last)
}

// ── one drawing operation ──
struct Draw<'a> {
    cw: usize,
    ch: usize,
    clip: Option<&'a [u8]>,
    alpha: f64,
    op: Op,
    // The CTM inverted: a device pixel's user-space point.
    inv: Option<Matrix>,
}

impl Draw<'_> {
    fn user(&self, px: usize, py: usize) -> (f64, f64) {
        let inv = self.inv.as_ref().expect("a sampled paint has an invertible CTM");
        apply(inv, px as f64 + 0.5, py as f64 + 0.5)
    }
    fn clipped(&self, idx: usize) -> bool {
        self.clip.is_some_and(|c| c.get(idx).copied().unwrap_or(0) == 0)
    }

    // Paint `shape` with `paint` into `buf`: its shadow first, then the shape itself, under the operator.
    fn run(&self, buf: &mut [u8], shape: &Shape<'_>, paint: &Paint<'_>, shadow: Option<&Shadow>) -> Result<(), Oom> {
        if let Paint::Clear = paint {
            shape.cover(self.cw, self.ch, (0.0, 0.0), &mut |px, py, cov| {
                let idx = py * self.cw + px;
                if self.clipped(idx) {
                    return;
                }
                let i = idx * 4;
                if cov >= 1.0 {
                    buf[i..i + 4].fill(0);
                } else {
                    buf[i + 3] = byte(f64::from(buf[i + 3]) * (1.0 - cov));
                }
            })?;
            return Ok(());
        }
        if let Some(shadow) = shadow {
            self.cast(buf, shape, paint, shadow)?;
        }
        let whole = self.op.whole_canvas();
        let paint_px = |buf: &mut [u8], idx: usize, px: usize, py: usize, cov: f64| {
            let (ux, uy) = if paint.sampled() { self.user(px, py) } else { (0.0, 0.0) };
            if let Some((col, a)) = paint.sample(ux, uy, whole) {
                composite(buf, idx * 4, col, clamp01(a * self.alpha * cov), self.op);
            }
        };
        if !whole {
            shape.cover(self.cw, self.ch, (0.0, 0.0), &mut |px, py, cov| {
                let idx = py * self.cw + px;
                if !self.clipped(idx) {
                    paint_px(buf, idx, px, py, cov);
                }
            })?;
            return Ok(());
        }
        // A whole-canvas operator: every pixel inside the clip is the operator's — blended where covered, cleared
        // where not.
        let mut plane = zeroed(self.cw * self.ch, 0f32)?;
        shape.cover(self.cw, self.ch, (0.0, 0.0), &mut |px, py, c| {
            let idx = py * self.cw + px;
            if c > f64::from(plane[idx]) {
                plane[idx] = c as f32;
            }
        })?;
        for (idx, &c) in plane.iter().enumerate() {
            if self.clipped(idx) {
                continue;
            }
            if c > 0.0 {
                paint_px(buf, idx, idx % self.cw, idx / self.cw, f64::from(c));
            } else {
                buf[idx * 4..idx * 4 + 4].fill(0);
            }
        }
        Ok(())
    }

    // Cast the shadow (§4.12.5.1.17): the shape's coverage, moved by the offset and weighted by the alpha the paint
    // deposits, blurred, tinted with the shadow colour and composited under the operator — source-over for a
    // whole-canvas one, whose surface-wide shadow layer this does not model.
    fn cast(&self, buf: &mut [u8], shape: &Shape<'_>, paint: &Paint<'_>, shadow: &Shadow) -> Result<(), Oom> {
        let (cw, ch) = (self.cw, self.ch);
        let mut plane = zeroed(cw * ch, 0f32)?;
        let shift = shadow.offset;
        shape.cover(cw, ch, shift, &mut |px, py, cov| {
            let a = match paint {
                Paint::Solid { a, .. } => *a,
                _ => {
                    let (ux, uy) = apply(self.inv.as_ref().expect("a sampled paint has an invertible CTM"), px as f64 - shift.0 + 0.5, py as f64 - shift.1 + 0.5);
                    paint.shadow_alpha(ux, uy)
                }
            };
            if a > 0.0 {
                let idx = py * cw + px;
                let c = cov * a;
                if c > f64::from(plane[idx]) {
                    plane[idx] = c as f32;
                }
            }
        })?;
        let plane = blur(plane, cw, ch, shadow.radius)?;
        let op = if self.op.whole_canvas() { Op::SourceOver } else { self.op };
        for (idx, &sc) in plane.iter().enumerate() {
            if sc <= 0.0 || self.clipped(idx) {
                continue;
            }
            composite(buf, idx * 4, shadow.col, clamp01(shadow.a * self.alpha * f64::from(sc)), op);
        }
        Ok(())
    }
}

struct Shadow {
    col: Rgb,
    a: f64,
    offset: (f64, f64),
    radius: usize,
}

// A Gaussian approximated by three separable box blurs of `radius`.
fn blur(plane: Vec<f32>, w: usize, h: usize, radius: usize) -> Result<Vec<f32>, Oom> {
    if radius == 0 {
        return Ok(plane);
    }
    let (mut a, mut b) = (plane, zeroed(w * h, 0f32)?);
    for _ in 0..3 {
        box_blur(&a, &mut b, w, h, radius, true);
        std::mem::swap(&mut a, &mut b);
        box_blur(&a, &mut b, w, h, radius, false);
        std::mem::swap(&mut a, &mut b);
    }
    Ok(a)
}
// One box-blur pass along rows (`horiz`) or columns, a sliding window, edges clamped.
fn box_blur(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize, horiz: bool) {
    let win = (radius * 2 + 1) as f64;
    let (lines, len, step) = if horiz { (h, w, 1) } else { (w, h, w) };
    let r = radius as isize;
    let at = |base: usize, i: isize| f64::from(src[base + step * i.clamp(0, len as isize - 1) as usize]);
    for line in 0..lines {
        let base = if horiz { line * w } else { line };
        let mut sum = 0.0;
        for i in -r..=r {
            sum += at(base, i);
        }
        for i in 0..len as isize {
            dst[base + step * i as usize] = (sum / win) as f32;
            sum += at(base, i + r + 1) - at(base, i - r);
        }
    }
}

// ── the ops ──
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "canvasDraw", canvas_draw, context_id);
    crate::dom::register(scope, ns, "canvasClip", canvas_clip, context_id);
    crate::dom::register(scope, ns, "canvasConvert", canvas_convert, context_id);
    crate::dom::register(scope, ns, "canvasBlit", canvas_blit, context_id);
}

// The bytes of a `Uint8ClampedArray` / `Uint8Array`: where they lie, and how many there are (none for a detached one).
fn bytes_span(val: v8::Local<'_, v8::Value>) -> Option<(*mut u8, usize)> {
    let view = v8::Local::<v8::ArrayBufferView>::try_from(val).ok()?;
    let (ptr, n) = (view.data() as *mut u8, view.byte_length());
    (n != 0 && !ptr.is_null()).then_some((ptr, n))
}
// …to write in place. An op takes at most ONE array so: every other it reads is `bytes_read`, which copies one that
// shares its bytes.
fn bytes_mut<'a>(val: v8::Local<'a, v8::Value>) -> Option<&'a mut [u8]> {
    let (ptr, n) = bytes_span(val)?;
    // SAFETY: the view's own bytes past its offset, valid for the op (no JS runs while it holds them), and borrowed by
    // nothing else (`bytes_read` copies whatever overlaps them).
    Some(unsafe { std::slice::from_raw_parts_mut(ptr, n) })
}
// …to read: borrowed where they do not overlap `written` (the array the op writes, if any), copied where they do — a
// canvas drawn onto itself reads its pixels from before the draw.
pub(crate) fn bytes_read<'a>(val: v8::Local<'a, v8::Value>, written: Option<(*mut u8, usize)>) -> Option<Cow<'a, [u8]>> {
    let (ptr, n) = bytes_span(val)?;
    // SAFETY: as `bytes_mut`, read only while the op runs.
    let bytes: &'a [u8] = unsafe { std::slice::from_raw_parts(ptr, n) };
    let overlaps = written.is_some_and(|(w, wn)| (ptr as usize) < w as usize + wn && (w as usize) < ptr as usize + n);
    Some(if overlaps { Cow::Owned(bytes.to_vec()) } else { Cow::Borrowed(bytes) })
}
// Throw a RangeError for a buffer an op could not have (`Oom`).
fn throw_oom(scope: &mut v8::PinScope<'_, '_>) {
    if let Some(msg) = v8::String::new(scope, "the canvas is too large to draw on") {
        let e = v8::Exception::range_error(scope, msg);
        scope.throw_exception(e);
    }
}

// The rings of a path shape, and whether they fill even-odd: `[1, evenOdd, …path]` the path filled, `[3, …pen,
// …path]` its stroke (canvas_path.rs `Path`, `Pen`).
fn rings_of(shape: &[f64]) -> Option<(Vec<Ring>, bool)> {
    match *shape.first()? as i32 {
        1 => Some((Path::parse(shape.get(2..)?)?.0.fill_rings(), shape[1] != 0.0)),
        3 => {
            let (pen, rest) = Pen::parse(&shape[1..])?;
            Some((Path::parse(rest)?.0.stroke_rings(&pen), false))
        }
        _ => None,
    }
}

// The stops of a flat `[count, offset, r, g, b, a, …]`, and what follows them.
fn stops_of(flat: &[f64]) -> Vec<Stop> {
    let n = flat.first().map_or(0, |&n| n as usize);
    flat.get(1..1 + 5 * n).unwrap_or(&[]).chunks_exact(5).map(|s| Stop { offset: s[0], r: s[1], g: s[2], b: s[3], a: s[4] }).collect()
}

// __dom.canvasDraw(bitmap, clip, shape, mask, paint, pixels, state, op): one drawing operation on a `w` × `h` bitmap
// (`Draw::run`).
//   shape: `[0, x0, y0, x1, y1]` a device box; `[1, evenOdd, …path]` a path filled, `[3, …pen, …path]` a path
//          stroked (`rings_of`); `[2, w, h, x, y]` the glyph mask `mask`.
//   paint: `[0, r, g, b, a]` a solid sRGB colour; `[1]` clearRect; `[2, x0, y0, x1, y1, …stops]` linear,
//          `[3, x0, y0, r0, x1, y1, r1, …stops]` radial, `[4, angle, x, y, …stops]` conic, stops `[count, offset, r, g,
//          b, a, …]` sRGB; `[5, w, h, repeatX, repeatY, p3, …matrix]` the pattern tile `pixels` in its colour space
//          and under its own transform; `[6, w, h, p3, sx, sy, sw, sh, dx, dy, dw, dh, smoothing]` drawImage of
//          `pixels`.
//   state: `[w, h, globalAlpha, …ctm, p3, shadowR, shadowG, shadowB, shadowA, shadowBlur, offsetX, offsetY]`, the
//          bitmap's colour space Display P3 where `p3`, the shadow colour sRGB (alpha 0 for none).
fn canvas_draw(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let state = crate::dom::f64_arg(args.get(6)).to_vec();
    let shape = crate::dom::f64_arg(args.get(2)).to_vec();
    let paint = crate::dom::f64_arg(args.get(4)).to_vec();
    let op = Op::parse(&args.get(7).to_rust_string_lossy(scope));
    if state.len() < 17 || shape.is_empty() || paint.is_empty() {
        return;
    }
    let (cw, ch) = (state[0] as usize, state[1] as usize);
    let ctm: Matrix = state[3..9].try_into().unwrap();
    // (…a transform past what a double holds — `scale(1e200)` twice — maps everything off any canvas: nothing is drawn)
    if !ctm.iter().all(|v| v.is_finite()) {
        return;
    }
    let p3 = state[9] != 0.0;
    let to = matrix(false, p3);
    let written = bytes_span(args.get(0));
    let mask = bytes_read(args.get(3), written).unwrap_or_default();
    let clip = bytes_read(args.get(1), written);
    let shape = match shape[0] as i32 {
        0 if shape.len() >= 5 => Shape::Box([shape[1], shape[2], shape[3], shape[4]]),
        2 if shape.len() >= 5 => {
            let (w, h) = (shape[1] as usize, shape[2] as usize);
            if w == 0 || h == 0 || mask.len() < w * h || !shape[3..5].iter().all(|v| v.is_finite()) {
                return;
            }
            Shape::Mask { mask: &mask, w, h, x: shape[3] as i64, y: shape[4] as i64 }
        }
        _ => match rings_of(&shape) {
            Some((rings, even_odd)) => Shape::Rings { rings, even_odd },
            None => return,
        },
    };
    // (…a pattern's or an image's pixels, copied where they share the bitmap's bytes or need converting)
    let pixels = |convert: Option<&[f64; 9]>| {
        let mut px = bytes_read(args.get(5), written).unwrap_or_default();
        if let Some(m) = convert {
            convert_buffer(m, px.to_mut());
        }
        px
    };
    let p = &paint[1..];
    let paint = match paint[0] as i32 {
        0 if p.len() >= 4 => {
            let col = convert_rgb(to, Rgb { r: p[0], g: p[1], b: p[2] });
            // (…a transparent one paints nothing, but under a whole-canvas operator, where it clears)
            if clamp01(p[3] * state[2]) <= 0.0 && !op.whole_canvas() {
                return;
            }
            Paint::Solid { col, a: p[3] }
        }
        1 => Paint::Clear,
        kind @ 2..=4 => {
            let (kind, rest) = match kind {
                2 if p.len() >= 4 => {
                    let (dx, dy) = (p[2] - p[0], p[3] - p[1]);
                    (Gradient::Linear { x0: p[0], y0: p[1], dx, dy, len2: dx * dx + dy * dy }, &p[4..])
                }
                3 if p.len() >= 6 => {
                    let (dcx, dcy, dr) = (p[3] - p[0], p[4] - p[1], p[5] - p[2]);
                    (Gradient::Radial { x0: p[0], y0: p[1], r0: p[2], dcx, dcy, dr, a: dcx * dcx + dcy * dcy - dr * dr }, &p[6..])
                }
                4 if p.len() >= 3 => (Gradient::Conic { a0: p[0], x: p[1], y: p[2] }, &p[3..]),
                _ => return,
            };
            let stops = stops_of(rest);
            // (…no stops, or a linear one of zero length, paints nothing)
            if stops.is_empty() || matches!(kind, Gradient::Linear { len2, .. } if len2 == 0.0) {
                return;
            }
            Paint::Gradient { kind, stops, to }
        }
        5 if p.len() >= 11 => {
            let (w, h) = (p[0] as usize, p[1] as usize);
            let px = pixels(matrix(p[4] != 0.0, p3));
            if w == 0 || h == 0 || px.len() < w * h * 4 {
                return;
            }
            let own: Matrix = p[5..11].try_into().unwrap();
            Paint::Pattern { px, w, h, rep_x: p[2] != 0.0, rep_y: p[3] != 0.0, inv: invert(&own).unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]) }
        }
        6 if p.len() >= 12 => {
            let (iw, ih) = (p[0] as usize, p[1] as usize);
            if iw == 0 || ih == 0 || !p[3..11].iter().all(|v| v.is_finite()) {
                return;
            }
            let px = pixels(matrix(p[2] != 0.0, p3));
            if px.len() < iw * ih * 4 {
                return;
            }
            let (src, dst) = ([p[3], p[4], p[5], p[6]], [p[7], p[8], p[9], p[10]]);
            // Bilinear only where smoothing is on AND the image is scaled or rotated on its way to the bitmap: an
            // aligned 1:1 (or mirrored) draw samples the same either way.
            let m = &ctm;
            let smooth = p[11] != 0.0
                && (m[1] != 0.0
                    || m[2] != 0.0
                    || (dst[2].abs() * m[0].hypot(m[1]) - src[2].abs()).abs() > 1e-3
                    || (dst[3].abs() * m[2].hypot(m[3]) - src[3].abs()).abs() > 1e-3);
            // (…its neighbours clamped to the SOURCE rectangle, so one cell of a sprite sheet does not bleed in the next)
            let (rxa, rxb) = (src[0].min(src[0] + src[2]), src[0].max(src[0] + src[2]));
            let (rya, ryb) = (src[1].min(src[1] + src[3]), src[1].max(src[1] + src[3]));
            let clamp = [
                rxa.floor().max(0.0) as i64,
                (rxb.ceil() - 1.0).min(iw as f64 - 1.0) as i64,
                rya.floor().max(0.0) as i64,
                (ryb.ceil() - 1.0).min(ih as f64 - 1.0) as i64,
            ];
            Paint::Image(Image { px, iw, ih, src, dst, scale: (src[2] / dst[2], src[3] / dst[3]), smooth, clamp })
        }
        _ => return,
    };
    let inv = invert(&ctm);
    if paint.sampled() && inv.is_none() {
        return;
    }
    let shadow = (state[13] > 0.0 && (state[14] > 0.0 || state[15] != 0.0 || state[16] != 0.0)).then(|| Shadow {
        col: convert_rgb(to, Rgb { r: state[10], g: state[11], b: state[12] }),
        a: state[13],
        offset: (js_round(state[15]), js_round(state[16])),
        radius: js_round(state[14] / 2.0).max(0.0) as usize,
    });
    let Some(buf) = bytes_mut(args.get(0)) else { return };
    if buf.len() < cw * ch * 4 {
        return;
    }
    let draw = Draw { cw, ch, clip: clip.as_deref(), alpha: state[2], op, inv };
    if draw.run(buf, &shape, &paint, shadow.as_ref()).is_err() {
        throw_oom(scope);
    }
}

// __dom.canvasClip(mask, w, h, shape, clip): the clip mask (1 inside) a path shape (`rings_of`) makes of a `w` × `h`
// bitmap, intersected with `clip`, written into `mask` (the page side allocates it, a size too large for it a
// RangeError there): a pixel is inside where it is at least half covered.
fn canvas_clip(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cw = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let ch = args.get(2).uint32_value(scope).unwrap_or(0) as usize;
    let (rings, even_odd) = rings_of(&crate::dom::f64_arg(args.get(3))).unwrap_or_default();
    let written = bytes_span(args.get(0));
    let old = bytes_read(args.get(4), written);
    let Some(mask) = bytes_mut(args.get(0)).filter(|m| m.len() >= cw * ch) else { return };
    mask.fill(0);
    let covered = Shape::Rings { rings, even_odd }.cover(cw, ch, (0.0, 0.0), &mut |px, py, cov| {
        if cov >= 0.5 {
            mask[py * cw + px] = 1;
        }
    });
    if covered.is_err() {
        return throw_oom(scope);
    }
    if let Some(old) = old {
        for (m, o) in mask.iter_mut().zip(old.iter()) {
            *m &= o;
        }
    }
}

// __dom.canvasConvert(pixels, fromP3, toP3): an RGBA buffer converted in place from one colour space to the other.
fn canvas_convert(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(m) = matrix(args.get(1).is_true(), args.get(2).is_true()) else { return };
    if let Some(data) = bytes_mut(args.get(0)) {
        convert_buffer(m, data);
    }
}

// __dom.canvasBlit(src, dst, geometry): `[srcW, srcH, sx, sy, sw, sh, dstW, dstH, dx, dy, dw, dh]` — the `sw` × `sh`
// rectangle at (sx, sy) of `src` copied over (dx, dy) of `dst`, scaled to `dw` × `dh` nearest-neighbour, what falls
// outside either left alone. What getImageData / putImageData move.
fn canvas_blit(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let g = crate::dom::f64_arg(args.get(2)).to_vec();
    if g.len() < 12 {
        return;
    }
    let Some(src) = bytes_read(args.get(0), bytes_span(args.get(1))) else { return };
    let Some(dst) = bytes_mut(args.get(1)) else { return };
    let [src_w, src_h, sx, sy, sw, sh, dst_w, dst_h, dx, dy, dw, dh] = g[..12].try_into().unwrap();
    if src.len() < (src_w * src_h * 4.0) as usize || dst.len() < (dst_w * dst_h * 4.0) as usize {
        return;
    }
    for row in 0..dh.max(0.0) as i64 {
        let src_row = sy + ((row as f64 * sh / dh) as i64) as f64;
        let dst_row = dy + row as f64;
        if dst_row < 0.0 || dst_row >= dst_h || src_row < 0.0 || src_row >= src_h {
            continue;
        }
        for col in 0..dw.max(0.0) as i64 {
            let src_col = sx + ((col as f64 * sw / dw) as i64) as f64;
            let dst_col = dx + col as f64;
            if dst_col < 0.0 || dst_col >= dst_w || src_col < 0.0 || src_col >= src_w {
                continue;
            }
            let s = ((src_row * src_w + src_col) * 4.0) as usize;
            let d = ((dst_row * dst_w + dst_col) * 4.0) as usize;
            dst[d..d + 4].copy_from_slice(&src[s..s + 4]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_as_a_clamped_array() {
        assert_eq!(byte(0.5), 0);
        assert_eq!(byte(1.5), 2);
        assert_eq!(byte(254.5), 254);
        assert_eq!(byte(-3.0), 0);
        assert_eq!(byte(300.0), 255);
        assert_eq!(byte(f64::NAN), 0);
    }

    #[test]
    fn covers_a_half_pixel_box_edge() {
        let mut got = Vec::new();
        Shape::Box([0.5, 0.0, 2.0, 1.0]).cover(4, 1, (0.0, 0.0), &mut |x, y, c| got.push((x, y, c))).unwrap();
        assert_eq!(got, vec![(0, 0, 0.5), (1, 0, 1.0)]);
    }

    #[test]
    fn fills_a_ring_by_winding() {
        let square = vec![(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
        let mut n = 0;
        Shape::Rings { rings: vec![square.clone(), square], even_odd: true }.cover(4, 4, (0.0, 0.0), &mut |_, _, _| n += 1).unwrap();
        assert_eq!(n, 0);
        let mut got = Vec::new();
        Shape::Rings { rings: vec![vec![(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]], even_odd: false }.cover(4, 4, (0.0, 0.0), &mut |x, y, c| got.push((x, y, c))).unwrap();
        assert_eq!(got.len(), 4);
        assert!(got.iter().all(|&(_, _, c)| c == 1.0));
    }

    #[test]
    fn composites_source_over_and_xor() {
        let mut buf = [0, 0, 255, 255];
        composite(&mut buf, 0, Rgb { r: 255.0, g: 0.0, b: 0.0 }, 0.5, Op::SourceOver);
        assert_eq!(buf, [128, 0, 128, 255]);
        let mut buf = [0, 0, 255, 255];
        composite(&mut buf, 0, Rgb { r: 255.0, g: 0.0, b: 0.0 }, 1.0, Op::Xor);
        assert_eq!(buf, [0, 0, 0, 0]);
    }
}
