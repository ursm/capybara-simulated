// The 2D canvas's rasterizer (HTML §4.12.5.1): what one drawing operation does to a canvas's bitmap. The shape it
// covers — a device box, polygon rings under a winding rule, or a glyph mask — gives each pixel an anti-aliased
// coverage; the paint (a solid colour, a gradient, a pattern, an image, or clearRect's clearing) gives it a colour; the
// compositing operator lays that over what is there, inside the clip mask, a shadow cast first where one is set (§4.12.5.1.17,
// the drawing model). And the colour spaces a bitmap can hold (sRGB / Display P3), converted between.
//
use std::borrow::Cow;

use crate::canvas_path::{invert, Path, Ring, FOCUS_RING, STROKE};
use crate::canvas_state::CanvasStateHandle;

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
// The four a bitmap can hold, by their index in canvas_state.rs `COLOR_SPACES`: sRGB and Display P3 — which share sRGB's
// transfer function — and each one's linear counterpart, with none. A conversion is: expand, a 3×3 matrix on linear RGB
// (D65), compress. A P3 colour outside sRGB's gamut is clipped into it, as a browser reads a wide colour back as sRGB.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Space {
    p3: bool,
    linear: bool,
}
const SRGB: Space = Space { p3: false, linear: false };
impl Space {
    pub(crate) fn of_code(code: u8) -> Space {
        Space { p3: code >= 2, linear: code & 1 == 1 }
    }
    pub(crate) fn of_name(name: &str) -> Space {
        let (base, linear) = name.strip_suffix("-linear").map_or((name, false), |b| (b, true));
        Space { p3: base == "display-p3", linear }
    }
    // Its encoded counterpart: what an image file or an ImageBitmap, which keep no linear values, hold of it.
    pub(crate) fn encoded(self) -> Space {
        Space { linear: false, ..self }
    }
    pub(crate) fn is_p3(self) -> bool {
        self.p3
    }
}
const SRGB_TO_P3: [f64; 9] = [0.82246197, 0.17753803, 0.0, 0.03319420, 0.96680580, 0.0, 0.01708263, 0.07239744, 0.91051993];
const P3_TO_SRGB: [f64; 9] = [1.22494018, -0.22494018, 0.0, -0.04205695, 1.04205695, 0.0, -0.01963755, -0.07863605, 1.09827360];
fn eotf(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn oetf(c: f64) -> f64 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}
// The matrix from one space's primaries to the other's, None where they are the same.
fn matrix(from: Space, to: Space) -> Option<&'static [f64; 9]> {
    match (from.p3, to.p3) {
        (false, true) => Some(&SRGB_TO_P3),
        (true, false) => Some(&P3_TO_SRGB),
        _ => None,
    }
}
// Whole bytes converted.
fn convert_bytes(from: Space, to: Space, bytes: [u8; 3]) -> [f64; 3] {
    let lin = bytes.map(|c| if from.linear { unit(c) } else { eotf(unit(c)) });
    let [r, g, b] = lin;
    let lin = matrix(from, to).map_or(lin, |m| [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b]);
    lin.map(|c| js_round(if to.linear { clamp01(c) } else { oetf(clamp01(c)) } * 255.0))
}
// A CSS colour (sRGB, as the state keeps one) in the space a bitmap holds: "converted to the context's color space".
fn in_space(to: Space, c: Rgb) -> Rgb {
    if to == SRGB {
        return c;
    }
    let [r, g, b] = convert_bytes(SRGB, to, [byte(c.r), byte(c.g), byte(c.b)]);
    Rgb { r, g, b }
}
// An RGBA buffer converted in place, its alpha untouched.
pub(crate) fn convert_buffer(from: Space, to: Space, data: &mut [u8]) {
    if from == to {
        return;
    }
    for px in data.chunks_exact_mut(4) {
        let [r, g, b] = convert_bytes(from, to, [px[0], px[1], px[2]]);
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
pub(crate) enum Shape<'a> {
    // A device box, its edges anti-aliased by area.
    Box([f64; 4]),
    // Polygon rings, under nonzero or (`even_odd`) the even-odd rule.
    Rings { rings: Vec<Ring>, even_odd: bool },
    // A glyph mask (`w` × `h` coverage bytes) placed at (`x`, `y`).
    Mask { mask: &'a [u8], w: usize, h: usize, x: i64, y: i64 },
}

impl Shape<'_> {
    // The device box the shape can cover (left, top, right, bottom) — None for one that covers nothing.
    fn bounds(&self) -> Option<[f64; 4]> {
        match self {
            // (…a box drawn with a negative width or height has its edges the other way round)
            &Shape::Box([x0, y0, x1, y1]) => Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]),
            Shape::Rings { rings, .. } => {
                let mut it = rings.iter().flatten();
                let &(x, y) = it.next()?;
                Some(it.fold([x, y, x, y], |[l, t, r, b], &(x, y)| [l.min(x), t.min(y), r.max(x), b.max(y)]))
            }
            &Shape::Mask { w, h, x, y, .. } => Some([x as f64, y as f64, (x + w as i64) as f64, (y + h as i64) as f64]),
        }
    }
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
    // A gradient: its stops, sorted, in the bitmap's space, where it interpolates them.
    Gradient { kind: Gradient, stops: Vec<Stop> },
    // A pattern's tile, in the bitmap's space already, tiled on the axes it repeats; sampled through `inv` (its own
    // transform, inverted).
    Pattern { px: Cow<'a, [u8]>, w: usize, h: usize, rep_x: bool, rep_y: bool, inv: Matrix },
    // drawImage: the image's (sx, sy, sw, sh) drawn into the user-space rectangle (dx, dy, dw, dh) — nearest, or with
    // `smooth`, bilinear.
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
        // does not bleed its colour in — from the image, whatever the source rectangle: "When the filtering algorithm
        // requires a pixel value from outside the source rectangle but inside the original image data, then the value
        // from the original image data must be used", and from outside the image "the value from the nearest edge pixel".
        // What a source point off the image would paint is clipped away: "When the source rectangle is outside the
        // source image, the source rectangle must be clipped to the source image and the destination rectangle must be
        // clipped in the same proportion".
        let (sx, sy) = self.source(ux, uy);
        if !(sx >= 0.0 && sy >= 0.0 && sx < self.iw as f64 && sy < self.ih as f64) {
            return whole.then_some((Rgb { r: 0.0, g: 0.0, b: 0.0 }, 0.0));
        }
        let (gx, gy) = (sx - 0.5, sy - 0.5);
        let (fx, fy) = (floor(gx), floor(gy));
        let (tx, ty) = (gx - fx, gy - fy);
        let (x0, y0) = (fx as i64, fy as i64);
        let held = |v: i64, n: usize| v.clamp(0, n as i64 - 1) as usize;
        let xs = [held(x0, self.iw), held(x0 + 1, self.iw)];
        let ys = [held(y0, self.ih), held(y0 + 1, self.ih)];
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
            Paint::Gradient { kind, stops } => Some(stop_colour(stops, gradient_t(kind, ux, uy)?)),
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
    // whole-canvas one, whose surface-wide shadow layer this does not model. The coverage is gathered on a plane that
    // reaches past the canvas by the blur's reach (`Shadow::reach`), so ink just off the canvas still blurs onto it.
    fn cast(&self, buf: &mut [u8], shape: &Shape<'_>, paint: &Paint<'_>, shadow: &Shadow) -> Result<(), Oom> {
        let (cw, ch) = (self.cw, self.ch);
        let m = shadow.reach(cw, ch) as f64;
        // (…only where the moved shape, grown by the reach, meets the canvas grown by it: a plane of that, its device
        // origin at (x0, y0) — whatever lies outside it is coverage none of the canvas's pixels can receive)
        let Some([l, t, r, b]) = shape.bounds() else { return Ok(()) };
        let (ox, oy) = shadow.offset;
        let span = |lo: f64, hi: f64, n: usize| ((lo.floor() - m).max(-m), (hi.ceil() + m).min(n as f64 + m));
        let ((x0, x1), (y0, y1)) = (span(l + ox, r + ox, cw), span(t + oy, b + oy, ch));
        if !(x0 < x1 && y0 < y1 && x1 > 0.0 && y1 > 0.0 && x0 < cw as f64 && y0 < ch as f64) {
            return Ok(());
        }
        let (pw, ph) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let mut plane = zeroed(pw * ph, 0f32)?;
        let shift = (ox - x0, oy - y0);
        shape.cover(pw, ph, shift, &mut |px, py, cov| {
            let a = match paint {
                Paint::Solid { a, .. } => *a,
                _ => {
                    let (ux, uy) = apply(self.inv.as_ref().expect("a sampled paint has an invertible CTM"), px as f64 - shift.0 + 0.5, py as f64 - shift.1 + 0.5);
                    paint.shadow_alpha(ux, uy)
                }
            };
            if a > 0.0 {
                let idx = py * pw + px;
                let c = cov * a;
                if c > f64::from(plane[idx]) {
                    plane[idx] = c as f32;
                }
            }
        })?;
        let plane = blur(plane, pw, ph, shadow.radius)?;
        let op = if self.op.whole_canvas() { Op::SourceOver } else { self.op };
        let (cx0, cy0) = (x0.max(0.0) as usize, y0.max(0.0) as usize);
        let (cx1, cy1) = (x1.min(cw as f64) as usize, y1.min(ch as f64) as usize);
        for y in cy0..cy1 {
            for x in cx0..cx1 {
                let sc = plane[(y as f64 - y0) as usize * pw + (x as f64 - x0) as usize];
                let idx = y * cw + x;
                if sc <= 0.0 || self.clipped(idx) {
                    continue;
                }
                composite(buf, idx * 4, shadow.col, clamp01(shadow.a * self.alpha * f64::from(sc)), op);
            }
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

impl Shadow {
    fn reach(&self, cw: usize, ch: usize) -> usize {
        blur_reach(self.radius, cw, ch)
    }
}

// The box radius whose three passes blur as the Gaussian a `shadowBlur` of `blur` asks for (§4.12.5.1.17: σ is half the
// blur): three boxes of width w have a variance of 3 (w² − 1) / 12, which is σ² where w = √(4σ² + 1).
pub(crate) fn blur_radius(blur: f64) -> usize {
    let sigma = blur.max(0.0) / 2.0;
    js_round(((4.0 * sigma * sigma + 1.0).sqrt() - 1.0) / 2.0) as usize
}
// How far a blur of `radius` carries coverage onto a `cw` × `ch` canvas, px: its three box passes, `radius` each — no
// further than the canvas is long, past which a blur that wide has spread whatever lies there thinner than it shows.
pub(crate) fn blur_reach(radius: usize, cw: usize, ch: usize) -> usize {
    (3 * radius).min(cw.max(ch))
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
    crate::dom::register(scope, ns, "canvasRect", canvas_rect, context_id);
    crate::dom::register(scope, ns, "canvasDrawPath", canvas_draw_path, context_id);
    crate::dom::register(scope, ns, "canvasClip", canvas_clip, context_id);
    crate::dom::register(scope, ns, "imageDataAllocate", image_data_allocate, context_id);
    crate::dom::register(scope, ns, "imageDataCheck", image_data_check, context_id);
    crate::dom::register(scope, ns, "imageDataArrayOver", image_data_array_over, context_id);
    crate::dom::register(scope, ns, "canvasFocusRing", canvas_focus_ring, context_id);
    crate::dom::register(scope, ns, "canvasGetImageData", canvas_get_image_data, context_id);
    crate::dom::register(scope, ns, "canvasPutImageData", canvas_put_image_data, context_id);
}

// The bytes of a `Uint8ClampedArray` / `Uint8Array`: where they lie, and how many there are (none for a detached one).
pub(crate) fn bytes_span(val: v8::Local<'_, v8::Value>) -> Option<(*mut u8, usize)> {
    let view = v8::Local::<v8::ArrayBufferView>::try_from(val).ok()?;
    let (ptr, n) = (view.data() as *mut u8, view.byte_length());
    (n != 0 && !ptr.is_null()).then_some((ptr, n))
}
// …to write in place. An op takes at most ONE array so: every other it reads is `bytes_read`, which copies one that
// shares its bytes.
pub(crate) fn bytes_mut<'a>(val: v8::Local<'a, v8::Value>) -> Option<&'a mut [u8]> {
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
pub(crate) fn throw_oom(scope: &mut v8::PinScope<'_, '_>) {
    if let Some(msg) = v8::String::new(scope, "the canvas's pixels are too large to hold") {
        let e = v8::Exception::range_error(scope, msg);
        scope.throw_exception(e);
    }
}

// The stops of a flat `[count, offset, r, g, b, a, …]`, "the color specified for that stop, converted to the context's
// color space".
fn stops_of(flat: &[f64], to: Space) -> Vec<Stop> {
    let n = flat.first().map_or(0, |&n| n as usize);
    let stop = |s: &[f64]| {
        let Rgb { r, g, b } = in_space(to, Rgb { r: s[1], g: s[2], b: s[3] });
        Stop { offset: s[0], r, g, b, a: s[4] }
    };
    flat.get(1..1 + 5 * n).unwrap_or(&[]).chunks_exact(5).map(stop).collect()
}

// The paint of a drawing op, flat: `[0, r, g, b, a]` a solid sRGB colour; `[1]` clearRect; `[2, x0, y0, x1, y1, …stops]`
// linear, `[3, x0, y0, r0, x1, y1, r1, …stops]` radial, `[4, angle, x, y, …stops]` conic, stops `[count, offset, r, g, b,
// a, …]` sRGB; `[5, w, h, repeatX, repeatY, space, …matrix]` the pattern tile `pixels` in its colour space and under its own
// transform; `[6, w, h, space, sx, sy, sw, sh, dx, dy, dw, dh, smoothing]` drawImage of `pixels`, a pattern's and an image's
// `space` the colour space of their pixels (`Space::of_code`).
const CLEAR: [f64; 1] = [1.0];
const FOCUS_RING_PAINT: [f64; 5] = [0.0, 0.0, 0.0, 0.0, 1.0];

// What `canvasRect` draws, and whether it draws at all: no rectangle with an argument that is not finite, nor a fill or a
// clear of one with no area — a stroke's is the line it is, as long as it has a width or a height.
const FILL_RECT: u32 = 0;
const CLEAR_RECT: u32 = 1;
const STROKE_RECT: u32 = 2;
fn rect_draws(how: u32, [x, y, w, h]: [f64; 4]) -> bool {
    [x, y, w, h].iter().all(|v| v.is_finite()) && if how == STROKE_RECT { w != 0.0 || h != 0.0 } else { w != 0.0 && h != 0.0 }
}
// …the shape a user-space rectangle fills: its device box where the CTM keeps it axis-aligned (no rotation or shear), its
// corners' ring otherwise.
fn rect_shape(m: Matrix, rect @ [x, y, w, h]: [f64; 4]) -> Shape<'static> {
    if m[1] == 0.0 && m[2] == 0.0 {
        return Shape::Box([m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5]]);
    }
    Shape::Rings { rings: Path::rect(m, rect).fill_rings(), even_odd: false }
}

// __dom.canvasRect(state, how, x, y, w, h): `fillRect` (`FILL_RECT`), `clearRect` (`CLEAR_RECT`: the covered pixels cleared,
// a partly covered edge in proportion, inside the clip — whatever the fill style, `globalAlpha` or the shadow) or
// `strokeRect` (`STROKE_RECT`: the rectangle's closed path stroked as `stroke()` would, its corners honouring `lineJoin`
// and `miterLimit`, the stroke scaling and rotating with the CTM) — every number one already, as the binding converted it.
fn canvas_rect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let how = args.get(1).uint32_value(scope).unwrap_or(FILL_RECT);
    let rect: [f64; 4] = std::array::from_fn(|i| v8::Local::<v8::Number>::try_from(args.get(i as i32 + 2)).map_or(f64::NAN, |n| n.value()));
    if !rect_draws(how, rect) {
        return;
    }
    if how == STROKE_RECT {
        let (rings, _) = { let s = h.state(); Path::rect(s.m, rect).rings(STROKE, &s) };
        return draw_style(scope, h, crate::canvas_state::STROKE, &Shape::Rings { rings, even_odd: false });
    }
    let m = h.state().m;
    let shape = rect_shape(m, rect);
    if how == CLEAR_RECT {
        let none = v8::null(scope).into();
        draw(scope, h, false, &shape, &CLEAR, none);
    } else {
        draw_style(scope, h, crate::canvas_state::FILL, &shape);
    }
}

// __dom.canvasDrawPath(state, how, path, baked): a path array — a Path2D's, or the context's current default path, whose
// points are device space already (`baked`) — filled by the nonzero or the even-odd rule with the fill style or stroked with
// the stroke style. Nothing for a path of no subpaths.
fn canvas_draw_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let how = args.get(1).uint32_value(scope).unwrap_or(crate::canvas_path::FILL_NONZERO);
    let baked = args.get(3).boolean_value(scope);
    draw_path(scope, h, how, args.get(2), baked);
}
// __dom.canvasFocusRing(state, canvas, element, path, baked): `drawFocusIfNeeded()`: "If element is not focused or is not a
// descendant of context's canvas element, then return" — else the path's focus ring (`FOCUS_RING`: a UA decoration, not an
// author stroke: a plain line, opaque and source-over, the clip alone applying).
fn canvas_focus_ring(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let (Some(canvas), Some(element)) = (crate::node_handle::nid_of(scope, args.get(1)), crate::node_handle::nid_of(scope, args.get(2))) else { return };
    let arena = &crate::dom::dom(scope).arena;
    if element == canvas || crate::focus::document_focus(arena, canvas) != Some(element) || !crate::ranges::contains(arena, canvas, element) {
        return;
    }
    let baked = args.get(4).boolean_value(scope);
    draw_path(scope, h, FOCUS_RING, args.get(3), baked);
}
fn draw_path(scope: &mut v8::PinScope<'_, '_>, h: &CanvasStateHandle, how: u32, path: v8::Local<'_, v8::Value>, baked: bool) {
    let (rings, even_odd) = {
        let path = crate::dom::f64_arg(path);
        if crate::canvas_path::path_empty(&path) {
            return;
        }
        let s = h.state();
        let Some(path) = Path::of(&path, s.m, baked) else { return };
        path.rings(how, &s)
    };
    let shape = Shape::Rings { rings, even_odd };
    match how {
        FOCUS_RING => {
            let none = v8::null(scope).into();
            draw(scope, h, true, &shape, &FOCUS_RING_PAINT, none);
        }
        STROKE => draw_style(scope, h, crate::canvas_state::STROKE, &shape),
        _ => draw_style(scope, h, crate::canvas_state::FILL, &shape),
    }
}

// A shape drawn with the state's fill or stroke style (`slot`): its gradient's or its pattern's paint (canvas_paint.rs
// `paint_data`), else its solid colour.
pub(crate) fn draw_style(scope: &mut v8::PinScope<'_, '_>, h: &CanvasStateHandle, slot: usize, shape: &Shape<'_>) {
    if let Some((data, own)) = h.object(scope, slot).and_then(|p| crate::canvas_paint::paint_data(scope, p)) {
        let own: v8::Local<'_, v8::Value> = own.map_or_else(|| v8::null(scope).into(), Into::into);
        return draw(scope, h, false, shape, &data, own);
    }
    let paint = {
        let s = h.state();
        let c = if slot == crate::canvas_state::FILL { &s.fill } else { &s.stroke };
        [0.0, f64::from(c.rgb[0]), f64::from(c.rgb[1]), f64::from(c.rgb[2]), c.a]
    };
    let none = v8::null(scope).into();
    draw(scope, h, false, shape, &paint, none);
}

// One drawing operation on the context's bitmap, in its colour space, made now where it has none (`Draw::run`): under
// its state (canvas_state.rs) — its clip, CTM, `globalAlpha`, compositing operator and shadow — or, `plain`, opaque and
// source-over with no shadow, the clip still applying. `pixels` a pattern's or an image's.
pub(crate) fn draw(scope: &mut v8::PinScope<'_, '_>, h: &CanvasStateHandle, plain: bool, shape: &Shape<'_>, paint: &[f64], pixels: v8::Local<'_, v8::Value>) {
    let bitmap = match h.drawable_bitmap(scope) {
        Ok(Some(bitmap)) => bitmap,
        Ok(None) => return,
        Err(Oom) => return throw_oom(scope),
    };
    let [cw, ch] = h.size();
    let own = Space::of_code(h.color_space_code());
    // (…copied out of the state: none of its strings or its dash list, on an op a draw loop makes by the thousand)
    let (ctm, alpha, composite, shadow_color, shadow_a, shadow_blur, shadow_offset) = {
        let s = h.state();
        (s.m, s.alpha, s.composite, s.shadow.rgb, s.shadow.a, s.shadow_blur, (s.shadow_x, s.shadow_y))
    };
    let (alpha, shadow_a) = if plain { (1.0, 0.0) } else { (alpha, shadow_a) };
    let op = Op::parse(if plain { "source-over" } else { crate::canvas_state::COMPOSITE_OPS[composite as usize] });
    let clip_object = h.object(scope, crate::canvas_state::CLIP);
    // (…a transform past what a double holds — `scale(1e200)` twice — maps everything off any canvas: nothing is drawn)
    if !ctm.iter().all(|v| v.is_finite()) {
        return;
    }
    let written = bytes_span(bitmap);
    let clip = clip_object.and_then(|c| bytes_read(c.into(), written));
    // (…a pattern's or an image's pixels, copied where they share the bitmap's bytes or need converting)
    let pixels = |space: f64| {
        let mut px = bytes_read(pixels, written).unwrap_or_default();
        let from = Space::of_code(space as u8);
        if from != own {
            convert_buffer(from, own, px.to_mut());
        }
        px
    };
    let Some((&kind, p)) = paint.split_first() else { return };
    let paint = match kind as i32 {
        0 if p.len() >= 4 => {
            let col = in_space(own, Rgb { r: p[0], g: p[1], b: p[2] });
            // (…a transparent one paints nothing, but under a whole-canvas operator, where it clears)
            if clamp01(p[3] * alpha) <= 0.0 && !op.whole_canvas() {
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
            let stops = stops_of(rest, own);
            // (…no stops, or a linear one of zero length, paints nothing)
            if stops.is_empty() || matches!(kind, Gradient::Linear { len2, .. } if len2 == 0.0) {
                return;
            }
            Paint::Gradient { kind, stops }
        }
        5 if p.len() >= 11 => {
            let (w, h) = (p[0] as usize, p[1] as usize);
            let px = pixels(p[4]);
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
            let px = pixels(p[2]);
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
            Paint::Image(Image { px, iw, ih, src, dst, scale: (src[2] / dst[2], src[3] / dst[3]), smooth })
        }
        _ => return,
    };
    let inv = invert(&ctm);
    if paint.sampled() && inv.is_none() {
        return;
    }
    let shadow = (shadow_a > 0.0 && (shadow_blur > 0.0 || shadow_offset.0 != 0.0 || shadow_offset.1 != 0.0)).then(|| Shadow {
        col: in_space(own, Rgb { r: f64::from(shadow_color[0]), g: f64::from(shadow_color[1]), b: f64::from(shadow_color[2]) }),
        a: shadow_a,
        offset: (js_round(shadow_offset.0), js_round(shadow_offset.1)),
        radius: blur_radius(shadow_blur),
    });
    let Some(buf) = bytes_mut(bitmap) else { return };
    if buf.len() < cw * ch * 4 {
        return;
    }
    let clears = matches!(paint, Paint::Clear) || !matches!(op, Op::SourceOver);
    let draw = Draw { cw, ch, clip: clip.as_deref(), alpha, op, inv };
    if draw.run(buf, shape, &paint, shadow.as_ref()).is_err() {
        return throw_oom(scope);
    }
    // (…over an opaque bitmap source-over leaves it opaque, a draw loop's usual case: nothing to look at)
    if clears && !h.alpha() {
        over_black(buf);
    }
}

// A bitmap with its alpha `false` after an operation that may have lowered some of it: "attempts to change the alpha
// component of any pixel must be silently ignored", but what is drawn is "honoured up to the point where [it] would impact
// the output bitmap's alpha component" — each pixel as it shows over the black the bitmap starts as.
fn over_black(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        if px[3] != 255 {
            let a = unit(px[3]);
            px[..3].iter_mut().for_each(|c| *c = byte(f64::from(*c) * a));
            px[3] = 255;
        }
    }
}

// __dom.canvasClip(state, how, path, baked): the clip mask (1 inside) a path array's fill (`Path::rings`, `how` the rule,
// `baked` as `canvasDrawPath`) makes of the context's bitmap, intersected with its clip and made its clip from then on: a
// pixel is inside where it is at least half covered. Nothing on a bitmap of no area.
fn canvas_clip(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let [cw, ch] = h.size();
    if cw == 0 || ch == 0 {
        return;
    }
    let how = args.get(1).uint32_value(scope).unwrap_or(crate::canvas_path::FILL_NONZERO);
    let baked = args.get(3).boolean_value(scope);
    let (rings, even_odd) = {
        let s = h.state();
        Path::of(&crate::dom::f64_arg(args.get(2)), s.m, baked).map_or_else(Default::default, |path| path.rings(how, &s))
    };
    let Some(made) = crate::dom::zeroed_clamped_array(scope, cw * ch) else { return throw_oom(scope) };
    let Some(mask) = bytes_mut(made) else { return };
    let covered = Shape::Rings { rings, even_odd }.cover(cw, ch, (0.0, 0.0), &mut |px, py, cov| {
        if cov >= 0.5 {
            mask[py * cw + px] = 1;
        }
    });
    if covered.is_err() {
        return throw_oom(scope);
    }
    let old_object = h.object(scope, crate::canvas_state::CLIP);
    if let Some(old) = old_object.and_then(|o| bytes_read(o.into(), None)) {
        for (m, o) in mask.iter_mut().zip(old.iter()) {
            *m &= o;
        }
    }
    h.set_object(scope, crate::canvas_state::CLIP, v8::Local::<v8::Object>::try_from(made).ok());
}

// An ImageData's components between its two pixel formats (HTML §4.12.5.1.15): "rgba-float16" ones — IEEE half-precision,
// as a Float16Array holds them (in the platform's byte order) — and "rgba-unorm8" ones, a byte each.
// A half's value.
fn half_value(bits: u16) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let fraction = f64::from(bits & 0x3ff);
    sign * match exponent {
        0 => fraction * 2f64.powi(-24),
        0x1f if fraction == 0.0 => f64::INFINITY,
        0x1f => f64::NAN,
        _ => (1024.0 + fraction) * 2f64.powi(exponent - 25),
    }
}
// …and a value's half, rounded to the nearest, ties to even (ECMA-262 ToFloat16 — what writing to a Float16Array does).
fn half_bits(value: f64) -> u16 {
    let sign: u16 = if value.is_sign_negative() { 0x8000 } else { 0 };
    let a = value.abs();
    if a.is_nan() {
        return 0x7e00;
    }
    if a < 2f64.powi(-14) {
        // (…a subnormal, its step 2^-24: one that rounds up to 1024 steps is the least normal half, which those bits are)
        return sign | (a * 2f64.powi(24)).round_ties_even() as u16;
    }
    let mut exponent = a.log2().floor() as i32;
    // (…log2's rounding on the edge of a power of two put right)
    if 2f64.powi(exponent) > a {
        exponent -= 1;
    } else if 2f64.powi(exponent + 1) <= a {
        exponent += 1;
    }
    let mut significand = (a * 2f64.powi(10 - exponent)).round_ties_even();
    if significand >= 2048.0 {
        significand /= 2.0;
        exponent += 1;
    }
    if exponent > 15 {
        return sign | 0x7c00;
    }
    sign | (((exponent + 15) as u16) << 10) | (significand as u16 - 1024)
}
// "rgba-float16" components, each scaled to a byte (`byte(v * 255)`): what `Uint8ClampedArray.from(data, (v) => v * 255)`
// makes, at no call per component.
pub(crate) fn unorm8(halves: &[u8]) -> Vec<u8> {
    halves.chunks_exact(2).map(|h| byte(half_value(u16::from_ne_bytes([h[0], h[1]])) * 255.0)).collect()
}
// The components of a Float16Array of `bytes`: each byte over 255 as a half (`half_bits(v / 255)`), what
// `Float16Array.from(bytes, (v) => v / 255)` makes.
fn float16_into(bytes: &[u8], halves: &mut [u8]) {
    for (&b, half) in bytes.iter().zip(halves.chunks_exact_mut(2)) {
        half.copy_from_slice(&half_bits(f64::from(b) / 255.0).to_ne_bytes());
    }
}

// A rectangle `[x, y, w, h]` with a negative width or height moved rather than mirrored: HTML's getImageData (by way of
// "initialize an ImageData", the magnitudes) and "put pixels from an ImageData onto a bitmap".
fn normalized([mut x, mut y, mut w, mut h]: [f64; 4]) -> [f64; 4] {
    if w < 0.0 {
        (x, w) = (x + w, -w);
    }
    if h < 0.0 {
        (y, h) = (y + h, -h);
    }
    [x, y, w, h]
}

// The `w` × `h` rectangle at (sx, sy) of `src` copied to (dx, dy) of `dst`, whole rows at a time, what falls outside
// either left alone. Each buffer is `[width, height]` of RGBA; nothing for one shorter than that.
fn copy_rect(src: &[u8], src_size: [i64; 2], [sx, sy, w, h]: [i64; 4], dst: &mut [u8], dst_size: [i64; 2], [dx, dy]: [i64; 2]) {
    if (src.len() as i64) < src_size[0] * src_size[1] * 4 || (dst.len() as i64) < dst_size[0] * dst_size[1] * 4 {
        return;
    }
    let (off_x, off_y) = (dx - sx, dy - sy);
    let (x0, x1) = (sx.max(0).max(-off_x), (sx + w).min(src_size[0]).min(dst_size[0] - off_x));
    let (y0, y1) = (sy.max(0).max(-off_y), (sy + h).min(src_size[1]).min(dst_size[1] - off_y));
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let bytes = ((x1 - x0) * 4) as usize;
    for y in y0..y1 {
        let from = ((y * src_size[0] + x0) * 4) as usize;
        let to = (((y + off_y) * dst_size[0] + x0 + off_x) * 4) as usize;
        dst[to..to + bytes].copy_from_slice(&src[from..from + bytes]);
    }
}

// Why an ImageData is not made (HTML §4.12.5.1.15), the bindings' to throw, as the object is theirs to make: an
// IndexSizeError for no area; a SecurityError for a bitmap that is not origin-clean; "initialize an ImageData"'s RangeError,
// for a pixel array past any (whatwg/html#520), the check before the attempt, as an absurd size would abort the isolate
// rather than throw; for an array given, an InvalidStateError for a length no whole number of pixels, an IndexSizeError for
// one that is no multiple of its width or does not make its height, and an InvalidStateError for an array of the other
// pixel format's type, refused only after those.
const IMAGE_DATA_NO_AREA: u32 = 1;
const IMAGE_DATA_TAINTED: u32 = 2;
const IMAGE_DATA_TOO_LARGE: u32 = 3;
const IMAGE_DATA_BAD_LENGTH: u32 = 4;
const IMAGE_DATA_BAD_WIDTH: u32 = 5;
const IMAGE_DATA_BAD_HEIGHT: u32 = 6;
const IMAGE_DATA_BAD_TYPE: u32 = 7;
fn image_data_area_refusal([w, h]: [f64; 2], float16: bool) -> Option<u32> {
    if w == 0.0 || h == 0.0 {
        return Some(IMAGE_DATA_NO_AREA);
    }
    let component_bytes = if float16 { 2.0 } else { 1.0 };
    (w.abs() * h.abs() * 4.0 * component_bytes > crate::canvas_image::MAX_IMAGE_BYTES as f64).then_some(IMAGE_DATA_TOO_LARGE)
}
fn get_image_data_refusal(origin_clean: bool, size: [f64; 2], float16: bool) -> Option<u32> {
    match image_data_area_refusal(size, float16) {
        Some(IMAGE_DATA_NO_AREA) => Some(IMAGE_DATA_NO_AREA),
        _ if !origin_clean => Some(IMAGE_DATA_TAINTED),
        refusal => refusal,
    }
}
// …of an array of `bytes`, of its pixel format's type or not: its height, or why not.
fn image_data_height(bytes: usize, width: f64, height: Option<f64>, float16: bool, of_type: bool) -> Result<f64, u32> {
    let pixels = bytes as f64 / if float16 { 8.0 } else { 4.0 };
    if pixels == 0.0 || pixels.fract() != 0.0 {
        return Err(IMAGE_DATA_BAD_LENGTH);
    }
    if width == 0.0 || pixels % width != 0.0 {
        return Err(IMAGE_DATA_BAD_WIDTH);
    }
    let rows = pixels / width;
    if height.is_some_and(|h| h != rows) {
        return Err(IMAGE_DATA_BAD_HEIGHT);
    }
    if of_type { Ok(rows) } else { Err(IMAGE_DATA_BAD_TYPE) }
}
// __dom.imageDataAllocate(width, height, float16) -> a new pixel array of transparent black, of its pixel format's type,
// or why not (`IMAGE_DATA_NO_AREA`, `IMAGE_DATA_TOO_LARGE`).
fn image_data_allocate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [w, h] = [0, 1].map(|i| args.get(i).number_value(scope).unwrap_or(0.0));
    let float16 = args.get(2).is_true();
    if let Some(refusal) = image_data_area_refusal([w, h], float16) {
        return rv.set_uint32(refusal);
    }
    let n = (w * h * 4.0) as usize;
    let made = if float16 { crate::dom::zeroed_float16_array(scope, n) } else { crate::dom::zeroed_clamped_array(scope, n) };
    match made {
        Some(array) => rv.set(array),
        None => throw_oom(scope),
    }
}
// __dom.imageDataCheck(data, width, height | undefined, float16) -> the height of an ImageData of the array `data`, or
// minus why not.
fn image_data_check(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = args.get(0);
    let bytes = v8::Local::<v8::ArrayBufferView>::try_from(data).map_or(0, |v| v.byte_length());
    let width = args.get(1).number_value(scope).unwrap_or(0.0);
    let height = (!args.get(2).is_undefined()).then(|| args.get(2).number_value(scope).unwrap_or(0.0));
    let float16 = args.get(3).is_true();
    let of_type = if float16 { data.is_float16_array() } else { data.is_uint8_clamped_array() };
    match image_data_height(bytes, width, height, float16, of_type) {
        Ok(rows) => rv.set_double(rows),
        Err(refusal) => rv.set_double(-f64::from(refusal)),
    }
}
// __dom.imageDataArrayOver(view, float16) -> a pixel array over the bytes of `view`, as a worker's message carried them.
fn image_data_array_over(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)) else { return };
    let Some(buffer) = view.buffer(scope) else { return };
    let (offset, bytes) = (view.byte_offset(), view.byte_length());
    let made: Option<v8::Local<'_, v8::Value>> = if args.get(1).is_true() {
        crate::dom::float16_array(scope, buffer, offset, bytes / 2)
    } else {
        v8::Uint8ClampedArray::new(scope, buffer, offset, bytes).map(Into::into)
    };
    if let Some(array) = made {
        rv.set(array);
    }
}

// __dom.canvasGetImageData(state, x, y, w, h, float16, colorSpace) -> the rectangle's pixels in a new pixel array of its
// magnitudes, in the colour space given and its pixel format's type (`float16`: each byte over 255) — transparent black
// outside the bitmap — or why it refuses (`IMAGE_DATA_NO_AREA` …).
fn canvas_get_image_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    let rect: [f64; 4] = std::array::from_fn(|i| args.get(i as i32 + 1).number_value(scope).unwrap_or(0.0));
    let float16 = args.get(5).is_true();
    if let Some(refusal) = get_image_data_refusal(h.origin_clean(), [rect[2], rect[3]], float16) {
        return rv.set_uint32(refusal);
    }
    let target = Space::of_name(&args.get(6).to_rust_string_lossy(scope));
    let [x, y, w, hgt] = normalized(rect).map(|v| v as i64);
    let Some(made) = crate::dom::zeroed_clamped_array(scope, (w * hgt * 4) as usize) else { return throw_oom(scope) };
    let bitmap = h.bitmap(scope);
    if let (Some(bytes), Some(out)) = (bytes_read(bitmap, None), bytes_mut(made)) {
        let [cw, ch] = h.size().map(|v| v as i64);
        copy_rect(&bytes, [cw, ch], [x, y, w, hgt], out, [w, hgt], [0, 0]);
        convert_buffer(Space::of_code(h.color_space_code()), target, out);
    }
    if !float16 {
        return rv.set(made);
    }
    let Some(halves) = crate::dom::zeroed_float16_array(scope, (w * hgt * 4) as usize) else { return throw_oom(scope) };
    if let (Some(bytes), Some(out)) = (bytes_read(made, None), bytes_mut(halves)) {
        float16_into(&bytes, out);
    }
    rv.set(halves);
}

// __dom.canvasPutImageData(state, data, float16, colorSpace, width, height, dx, dy, dirtyX, dirtyY, dirtyWidth,
// dirtyHeight) -> HTML's "put pixels from an ImageData onto a bitmap": `data` its pixel array, in that colour space, of
// that size and of "rgba-float16" components where `float16`, its dirty rectangle's pixels replacing those at (dx, dy) on
// the bitmap, in the context's colour space, what falls outside either left alone — whether its buffer was detached, the
// bindings' to throw for.
fn canvas_put_image_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = crate::canvas_state::handle(scope, args.get(0)) else { return };
    if bytes_span(args.get(1)).is_none() {
        return rv.set_bool(true);
    }
    rv.set_bool(false);
    let number = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).number_value(scope).unwrap_or(0.0);
    let image = [number(scope, 4) as i64, number(scope, 5) as i64];
    let (dx, dy) = (number(scope, 6) as i64, number(scope, 7) as i64);
    let dirty = [number(scope, 8), number(scope, 9), number(scope, 10), number(scope, 11)];
    let [x, y, w, hgt] = normalized(dirty).map(|v| v as i64);
    let bitmap = match h.drawable_bitmap(scope) {
        Ok(Some(bitmap)) => bitmap,
        Ok(None) => return,
        Err(Oom) => return throw_oom(scope),
    };
    let (from, own) = (Space::of_name(&args.get(3).to_rust_string_lossy(scope)), Space::of_code(h.color_space_code()));
    let Some(mut px) = bytes_read(args.get(1), bytes_span(bitmap)) else { return };
    if args.get(2).is_true() {
        px = Cow::Owned(unorm8(&px));
    }
    if from != own {
        convert_buffer(from, own, px.to_mut());
    }
    let Some(dst) = bytes_mut(bitmap) else { return };
    let [cw, ch] = h.size().map(|v| v as i64);
    copy_rect(&px, image, [x, y, w, hgt], dst, [cw, ch], [dx + x, dy + y]);
    // (…"the putImageData() method effectively ignores every fourth byte in its input" where its alpha is `false`)
    if !h.alpha() {
        dst.chunks_exact_mut(4).for_each(|px| px[3] = 255);
    }
}

// The `sw` × `sh` rectangle at (sx, sy) of `src` copied over (dx, dy) of `dst`, scaled to `dw` × `dh` nearest-neighbour,
// what falls outside either left alone.
fn blit(src: &[u8], dst: &mut [u8], [src_w, src_h, sx, sy, sw, sh, dst_w, dst_h, dx, dy, dw, dh]: [f64; 12]) {
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

// The largest bitmap createImageBitmap densely materializes (RGBA, ≈512 MB): a crop or a resize past it can't be backed
// by a real buffer, and is refused — as a browser's max-texture limit would.
const MAX_BITMAP_AREA: f64 = (1u64 << 27) as f64;

// createImageBitmap's steps on the source's pixels (HTML §8.10 "crop the image to the source rectangle, scaled to the
// resize size, flipped"): `geometry` is `[width, height, crop, sx, sy, sw, sh, resizeWidth, resizeHeight, flipY]`, `crop`
// and `flipY` 0 or 1 and a resize size NaN when the options give none. The source rectangle's negative width or height
// moves it rather than mirroring it; one resize size alone keeps the aspect ratio; the scaling is nearest-neighbour, what
// falls outside the source transparent black. `None` when the output would be too large to hold.
pub(crate) fn bitmap_pixels(src: &[u8], g: [f64; 10]) -> Option<(Vec<u8>, f64, f64)> {
    let [w, h, crop, mut sx, mut sy, mut sw, mut sh, rw, rh, flip] = g;
    if crop == 0.0 {
        (sx, sy, sw, sh) = (0.0, 0.0, w, h);
    }
    if sw < 0.0 {
        (sx, sw) = (sx + sw, -sw);
    }
    if sh < 0.0 {
        (sy, sh) = (sy + sh, -sh);
    }
    let (ow, oh) = match (rw.is_nan(), rh.is_nan()) {
        (true, true) => (sw, sh),
        (false, true) => (rw, (sh * rw / sw).round().max(1.0)),
        (true, false) => ((sw * rh / sh).round().max(1.0), rh),
        (false, false) => (rw, rh),
    };
    if sw * sh > MAX_BITMAP_AREA || ow * oh > MAX_BITMAP_AREA {
        return None;
    }
    let mut out = vec![0; (ow * oh * 4.0) as usize];
    blit(src, &mut out, [w, h, sx, sy, sw, sh, ow, oh, 0.0, 0.0, ow, oh]);
    if flip != 0.0 {
        let row = ow as usize * 4;
        let rows: Vec<&[u8]> = out.chunks_exact(row).rev().collect();
        out = rows.concat();
    }
    Some((out, ow, oh))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A rectangle of pixels copied, each byte its pixel's column, as `blit` at no scale copies it — wherever the two
    // rectangles lie, off either buffer on any side.
    #[test]
    fn copies_a_rectangle_as_a_blit_at_no_scale_does() {
        let src: Vec<u8> = (0..4 * 3 * 4).map(|i| i as u8 + 1).collect();
        let cases = [
            ([0, 0, 4, 3], [0, 0]),
            ([1, 1, 2, 2], [0, 0]),
            ([-2, -1, 4, 3], [0, 0]),
            ([2, 1, 9, 9], [1, 1]),
            ([0, 0, 4, 3], [-1, -1]),
            ([0, 0, 4, 3], [3, 4]),
            ([9, 9, 2, 2], [0, 0]),
            ([0, 0, 2, 2], [9, 9]),
            ([0, 0, 0, 2], [0, 0]),
        ];
        for ([sx, sy, w, h], [dx, dy]) in cases {
            let (mut copied, mut blitted) = (vec![0; 5 * 5 * 4], vec![0; 5 * 5 * 4]);
            copy_rect(&src, [4, 3], [sx, sy, w, h], &mut copied, [5, 5], [dx, dy]);
            let g = [4.0, 3.0, sx as f64, sy as f64, w as f64, h as f64, 5.0, 5.0, dx as f64, dy as f64, w as f64, h as f64];
            blit(&src, &mut blitted, g);
            assert_eq!(copied, blitted, "{sx},{sy} {w}x{h} to {dx},{dy}");
        }
        // (…a buffer shorter than its size, a resizable one shrunk: nothing)
        let mut dst = vec![0; 4];
        copy_rect(&src[..4], [4, 3], [0, 0, 1, 1], &mut dst, [1, 1], [0, 0]);
        assert_eq!(dst, vec![0; 4]);
    }

    // HTML's getImageData refuses no area first, a bitmap not origin-clean next, a size past any array last.
    #[test]
    fn get_image_data_refuses_in_html_s_order() {
        assert_eq!(get_image_data_refusal(true, [1.0, 1.0], false), None);
        assert_eq!(get_image_data_refusal(true, [-1.0, 1.0], false), None);
        assert_eq!(get_image_data_refusal(false, [0.0, 1.0], false), Some(IMAGE_DATA_NO_AREA));
        assert_eq!(get_image_data_refusal(false, [1e9, 1e9], false), Some(IMAGE_DATA_TAINTED));
        assert_eq!(get_image_data_refusal(true, [1e9, -1e9], false), Some(IMAGE_DATA_TOO_LARGE));
        // (…a float16 array's bytes twice an 8-bit one's)
        assert_eq!(get_image_data_refusal(true, [32767.0, 32767.0], false), None);
        assert_eq!(get_image_data_refusal(true, [32767.0, 32767.0], true), Some(IMAGE_DATA_TOO_LARGE));
    }

    // An array given to `new ImageData`: its length first, its width, its height, and last its type.
    #[test]
    fn an_image_data_array_is_refused_in_html_s_order() {
        assert_eq!(image_data_height(16, 2.0, None, false, true), Ok(2.0));
        assert_eq!(image_data_height(16, 2.0, Some(2.0), false, true), Ok(2.0));
        assert_eq!(image_data_height(16, 1.0, None, true, true), Ok(2.0));
        assert_eq!(image_data_height(0, 1.0, None, false, true), Err(IMAGE_DATA_BAD_LENGTH));
        assert_eq!(image_data_height(6, 1.0, None, false, false), Err(IMAGE_DATA_BAD_LENGTH));
        assert_eq!(image_data_height(12, 0.0, None, false, false), Err(IMAGE_DATA_BAD_WIDTH));
        assert_eq!(image_data_height(12, 2.0, None, false, false), Err(IMAGE_DATA_BAD_WIDTH));
        assert_eq!(image_data_height(16, 2.0, Some(3.0), false, false), Err(IMAGE_DATA_BAD_HEIGHT));
        assert_eq!(image_data_height(16, 2.0, None, false, false), Err(IMAGE_DATA_BAD_TYPE));
    }

    // A bilinear sample takes its neighbours from the image, past the source rectangle (HTML: "the value from the original
    // image data must be used"), holds at its edge, and paints nothing off it.
    #[test]
    fn samples_past_the_source_rectangle_but_not_past_the_image() {
        let px: Cow<'_, [u8]> = Cow::Owned(vec![255, 0, 0, 255, 0, 0, 255, 255]);
        let image = Image { px, iw: 2, ih: 1, src: [0.0, 0.0, 1.0, 1.0], dst: [0.0, 0.0, 40.0, 40.0], scale: (1.0 / 40.0, 1.0 / 40.0), smooth: true };
        let (c, a) = image.sample(39.5, 20.0, false).unwrap();
        assert!((c.r - 130.7).abs() < 0.1 && (c.b - 124.3).abs() < 0.1 && (a - 1.0).abs() < 1e-9, "{} {} {a}", c.r, c.b);
        let (c, _) = image.sample(0.5, 20.0, false).unwrap();
        assert_eq!((c.r, c.b), (255.0, 0.0));
        let outside = Image { src: [-1.0, 0.0, 2.0, 1.0], dst: [0.0, 0.0, 40.0, 40.0], scale: (2.0 / 40.0, 1.0 / 40.0), ..image };
        assert!(outside.sample(10.0, 20.0, false).is_none());
        assert!(outside.sample(10.0, 20.0, true).is_some_and(|(_, a)| a == 0.0));
        assert!(outside.sample(30.0, 20.0, false).is_some());
    }

    #[test]
    fn a_pixel_with_its_alpha_fixed_shows_over_black() {
        let mut px = [255, 0, 100, 255, 255, 0, 100, 0, 200, 100, 0, 51];
        over_black(&mut px);
        assert_eq!(px, [255, 0, 100, 255, 0, 0, 0, 255, 40, 20, 0, 255]);
    }

    // A linear space has no transfer function: a CSS gray of 128 is 55 in `srgb-linear` and in `display-p3-linear`, whose
    // primaries leave a gray a gray; a conversion and its inverse come back; one between a space and itself does nothing.
    #[test]
    fn converts_between_the_four_spaces() {
        let (srgb, linear, p3, p3_linear) = (Space::of_code(0), Space::of_code(1), Space::of_code(2), Space::of_code(3));
        assert_eq!(Space::of_name("display-p3-linear"), p3_linear);
        assert_eq!(p3_linear.encoded(), p3);
        assert_eq!(convert_bytes(srgb, linear, [128, 128, 128]), [55.0, 55.0, 55.0]);
        assert_eq!(convert_bytes(srgb, p3_linear, [128, 128, 128]), [55.0, 55.0, 55.0]);
        assert_eq!(convert_bytes(linear, srgb, [55, 55, 55]), [128.0, 128.0, 128.0]);
        assert_eq!(convert_bytes(srgb, p3, [128, 128, 128]), [128.0, 128.0, 128.0]);
        let mut px = [255, 0, 0, 7];
        convert_buffer(srgb, p3, &mut px);
        assert_ne!(px, [255, 0, 0, 7]);
        assert_eq!(px[3], 7);
        let mut same = [1, 2, 3, 4];
        convert_buffer(linear, linear, &mut same);
        assert_eq!(same, [1, 2, 3, 4]);
        // (…a colour on the way to a bitmap: none for sRGB's)
        let c = Rgb { r: 128.0, g: 0.0, b: 0.0 };
        assert_eq!(in_space(srgb, c).r, 128.0);
        assert_eq!(in_space(linear, c).r, 55.0);
    }

    #[test]
    fn a_negative_extent_moves_a_rectangle() {
        assert_eq!(normalized([5.0, 6.0, -2.0, -3.0]), [3.0, 3.0, 2.0, 3.0]);
        assert_eq!(normalized([5.0, 6.0, 2.0, 3.0]), [5.0, 6.0, 2.0, 3.0]);
    }

    // HTML's early returns of fillRect, clearRect and strokeRect: non-finite first, no area for the two that fill, no
    // width AND no height for the one that strokes.
    #[test]
    fn a_rect_op_draws_what_html_says() {
        for how in [FILL_RECT, CLEAR_RECT, STROKE_RECT] {
            assert!(rect_draws(how, [0.0, 0.0, 1.0, 1.0]));
            assert!(rect_draws(how, [0.0, 0.0, -1.0, -1.0]));
            for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                assert!(!rect_draws(how, [bad, 0.0, 1.0, 1.0]));
                assert!(!rect_draws(how, [0.0, 0.0, 1.0, bad]));
            }
            assert!(!rect_draws(how, [0.0, 0.0, 0.0, 0.0]));
            assert!(!rect_draws(how, [0.0, 0.0, -0.0, 0.0]));
        }
        assert!(!rect_draws(FILL_RECT, [0.0, 0.0, 0.0, 1.0]));
        assert!(!rect_draws(CLEAR_RECT, [0.0, 0.0, 1.0, 0.0]));
        assert!(rect_draws(STROKE_RECT, [0.0, 0.0, 0.0, 1.0]));
        assert!(rect_draws(STROKE_RECT, [0.0, 0.0, 1.0, 0.0]));
    }

    // Under a CTM with no rotation or shear a rectangle is a device box, whatever its scale (a -0 entry no rotation at
    // all); under any other, its corners' ring.
    #[test]
    fn a_rect_is_a_box_while_the_ctm_keeps_it_axis_aligned() {
        let rect = [1.0, 2.0, 3.0, 4.0];
        assert!(matches!(rect_shape([2.0, 0.0, 0.0, 3.0, 10.0, 20.0], rect), Shape::Box([12.0, 26.0, 18.0, 38.0])));
        assert!(matches!(rect_shape([2.0, -0.0, -0.0, 3.0, 0.0, 0.0], rect), Shape::Box(_)));
        match rect_shape([0.0, 1.0, -1.0, 0.0, 0.0, 0.0], rect) {
            Shape::Rings { rings, even_odd } => {
                assert_eq!(rings, vec![vec![(-2.0, 1.0), (-2.0, 4.0), (-6.0, 4.0), (-6.0, 1.0)]]);
                assert!(!even_odd);
            }
            _ => panic!("a rotated rectangle is a ring"),
        }
    }


    // A half: 1, a half, the largest, past it infinity, the least subnormal; ties to even; every byte over 255 back to
    // itself through a half, as a float16 ImageData keeps an 8-bit canvas's pixels.
    #[test]
    fn halves_round_to_the_nearest_even_and_keep_every_byte() {
        assert_eq!((half_bits(1.0), half_bits(0.5), half_bits(65504.0), half_bits(65520.0)), (0x3c00, 0x3800, 0x7bff, 0x7c00));
        assert_eq!((half_bits(2f64.powi(-24)), half_bits(-0.0), half_bits(f64::NAN) & 0x7c00), (1, 0x8000, 0x7c00));
        assert_eq!(half_bits(1.0 + 2f64.powi(-11)), 0x3c00);
        assert_eq!(half_bits(1.0 + 3.0 * 2f64.powi(-11)), 0x3c02);
        assert_eq!((half_value(0x3c00), half_value(0x0001), half_value(0xfc00)), (1.0, 2f64.powi(-24), f64::NEG_INFINITY));
        for b in 0..=255u8 {
            assert_eq!(byte(half_value(half_bits(f64::from(b) / 255.0)) * 255.0), b);
        }
    }

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
    fn crops_resizes_and_flips_a_bitmap() {
        let px: Vec<u8> = (0..4u8).flat_map(|n| [n, 0, 0, 255]).collect();   // 2 × 2: 0 1 / 2 3
        let (out, w, h) = bitmap_pixels(&px, [2.0, 2.0, 1.0, 1.0, 0.0, -1.0, 2.0, f64::NAN, f64::NAN, 1.0]).unwrap();
        assert_eq!((w, h), (1.0, 2.0));
        assert_eq!([out[0], out[4]], [2, 0]);
        let (out, w, h) = bitmap_pixels(&px, [2.0, 2.0, 1.0, -1.0, 0.0, 2.0, 1.0, 4.0, f64::NAN, 0.0]).unwrap();
        assert_eq!((w, h), (4.0, 2.0));
        assert_eq!(out[..16], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255]);
        assert!(bitmap_pixels(&px, [2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 65536.0, 65536.0, 0.0]).is_none());
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
