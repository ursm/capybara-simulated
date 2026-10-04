// The 2D canvas's paths (HTML §4.12.5.1.6, building paths; §4.12.5.1.8, drawing paths): curves and arcs flattened to
// the points a path keeps, SVG path data read into the calls that build it (Path2D's constructor), a path's points in
// device space for a fill, the outline a stroke paints (its dash pattern, joins and caps), and whether a point is in a
// path or on its stroke. The page side keeps a path's points; every computation on them is here.

use std::f64::consts::{PI, TAU};

pub(crate) type Ring = Vec<(f64, f64)>;
type Matrix = [f64; 6];

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}
pub(crate) fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let id = 1.0 / det;
    Some([m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id])
}

// ── flattening ──
// A cubic Bézier from (x0, y0) through the control points to (x, y), as the points after its start: enough of them for
// the curve to stay smooth at `scale` (the CTM's), 8 to 256.
fn cubic(p: [f64; 8], scale: f64) -> Vec<(f64, f64)> {
    let [x0, y0, c1x, c1y, c2x, c2y, x, y] = p;
    let len = (c1x - x0).hypot(c1y - y0) + (c2x - c1x).hypot(c2y - c1y) + (x - c2x).hypot(y - c2y);
    let n = (scale * len / 8.0).ceil().clamp(8.0, 256.0) as usize;
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            (a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y)
        })
        .collect()
}
// …and a quadratic one.
fn quadratic(p: [f64; 6], scale: f64) -> Vec<(f64, f64)> {
    let [x0, y0, cx, cy, x, y] = p;
    let n = (scale * ((cx - x0).hypot(cy - y0) + (x - cx).hypot(y - cy)) / 8.0).ceil().clamp(8.0, 256.0) as usize;
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            (u * u * x0 + 2.0 * u * t * cx + t * t * x, u * u * y0 + 2.0 * u * t * cy + t * t * y)
        })
        .collect()
}
// An elliptical arc — centre, radii, rotation, from `a0` to `a1`, anticlockwise where `ccw` — as its points, start to
// end. A sweep that is a whole nonzero number of turns draws the whole ellipse (`arc(0, 2π, true)`), not nothing.
fn arc(p: [f64; 8], scale: f64) -> Vec<(f64, f64)> {
    let [cx, cy, rx, ry, rot, a0, a1, ccw] = p;
    let (cos_r, sin_r) = (rot.cos(), rot.sin());
    let at = |t: f64| {
        let (ex, ey) = (rx * t.cos(), ry * t.sin());
        (cx + ex * cos_r - ey * sin_r, cy + ex * sin_r + ey * cos_r)
    };
    let delta = if ccw == 0.0 {
        let d = a1 - a0;
        let delta = if d >= TAU { TAU } else { (d % TAU + TAU) % TAU };
        if delta == 0.0 && d != 0.0 { TAU } else { delta }
    } else {
        let d = a0 - a1;
        let delta = if d >= TAU { -TAU } else { -((d % TAU + TAU) % TAU) };
        if delta == 0.0 && d != 0.0 { -TAU } else { delta }
    };
    let max_r = rx.max(ry) * scale;
    let n = (delta.abs() / TAU * max_r.max(12.0)).ceil().clamp(6.0, 2048.0) as usize;
    // A partial arc's samples cluster toward its ends (cosine spacing): a stroke's cap is square to the last CHORD,
    // and a chord as long as the middle ones tilts it far enough to overshoot the true end. A whole turn has no caps,
    // and a small arc's sample count sits near the floor, where the wider middle steps would show: both stay uniform.
    let uniform = delta.abs() >= TAU - 1e-9 || max_r < 16.0;
    (0..=n)
        .map(|i| {
            let u = i as f64 / n as f64;
            let s = if uniform { u } else { (1.0 - (PI * u).cos()) / 2.0 };
            at(a0 + delta * s)
        })
        .collect()
}
// arcTo's corner (§4.12.5.1.6): the tangent points on the two edges and the arc between them, `[t0x, t0y, cx, cy, a0,
// a1, ccw, t2x, t2y]` — or nothing where it is a straight line to the corner (a zero edge or radius, collinear points).
fn arc_to(p: [f64; 7]) -> Vec<f64> {
    let [x0, y0, x1, y1, x2, y2, r] = p;
    let (d01x, d01y, d21x, d21y) = (x0 - x1, y0 - y1, x2 - x1, y2 - y1);
    let (l01, l21) = (d01x.hypot(d01y), d21x.hypot(d21y));
    if l01 == 0.0 || l21 == 0.0 || r == 0.0 || d01x * d21y - d01y * d21x == 0.0 {
        return Vec::new();
    }
    let angle = ((d01x * d21x + d01y * d21y) / (l01 * l21)).clamp(-1.0, 1.0).acos();
    let tan = r / (angle / 2.0).tan();
    let (t0x, t0y) = (x1 + d01x / l01 * tan, y1 + d01y / l01 * tan);
    let (t2x, t2y) = (x1 + d21x / l21 * tan, y1 + d21y / l21 * tan);
    let (bx, by) = (d01x / l01 + d21x / l21, d01y / l01 + d21y / l21);
    let bl = match bx.hypot(by) {
        0.0 => 1.0,
        l => l,
    };
    let dc = r / (angle / 2.0).sin();
    let (cx, cy) = (x1 + bx / bl * dc, y1 + by / bl * dc);
    // (…the short way round)
    let a0 = (t0y - cy).atan2(t0x - cx);
    let mut delta = (t2y - cy).atan2(t2x - cx) - a0;
    while delta > PI {
        delta -= TAU;
    }
    while delta < -PI {
        delta += TAU;
    }
    vec![t0x, t0y, cx, cy, a0, a0 + delta, f64::from(u8::from(delta < 0.0)), t2x, t2y]
}

// ── SVG path data ──
// The calls a path data string makes (SVG 2 §9.3: M L H V C S Q T A Z, absolute and relative; a smooth curve reflects
// the last control point; an arc in endpoint form converted to its centre), flat: `0 x y` moveTo, `1 x y` lineTo,
// `2 c1x c1y c2x c2y x y` bezierCurveTo, `3 cx cy x y` quadraticCurveTo, `4 cx cy rx ry rotation a0 a1 ccw` ellipse,
// `5` closePath. It stops at the first token that makes no sense.
fn svg_path(d: &str) -> Vec<f64> {
    let toks = svg_tokens(d);
    let mut out = Vec::new();
    let (mut i, mut px, mut py, mut sx, mut sy, mut pcx, mut pcy) = (0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut last: Option<char> = None;
    while i < toks.len() {
        let before = i;
        let cmd = match toks[i] {
            Tok::Cmd(c) => {
                i += 1;
                c
            }
            Tok::Num(_) => match last {
                Some('M') => 'L',
                Some('m') => 'l',
                Some(c) => c,
                None => break,
            },
        };
        let mut num = || {
            let v = match toks.get(i) {
                Some(&Tok::Num(v)) => v,
                _ => f64::NAN,
            };
            i += 1;
            v
        };
        let (ox, oy) = if cmd.is_ascii_lowercase() { (px, py) } else { (0.0, 0.0) };
        let smooth = |kinds: &str| last.is_some_and(|c| kinds.contains(c.to_ascii_lowercase()));
        match cmd.to_ascii_uppercase() {
            'M' => {
                px = ox + num();
                py = oy + num();
                out.extend([0.0, px, py]);
                (sx, sy) = (px, py);
            }
            'L' => {
                px = ox + num();
                py = oy + num();
                out.extend([1.0, px, py]);
            }
            'H' => {
                px = ox + num();
                out.extend([1.0, px, py]);
            }
            'V' => {
                py = oy + num();
                out.extend([1.0, px, py]);
            }
            'C' | 'S' => {
                let (c1x, c1y) = if cmd.eq_ignore_ascii_case(&'C') {
                    (ox + num(), oy + num())
                } else if smooth("cs") {
                    (2.0 * px - pcx, 2.0 * py - pcy)
                } else {
                    (px, py)
                };
                let (c2x, c2y, ex, ey) = (ox + num(), oy + num(), ox + num(), oy + num());
                out.extend([2.0, c1x, c1y, c2x, c2y, ex, ey]);
                (pcx, pcy, px, py) = (c2x, c2y, ex, ey);
            }
            'Q' | 'T' => {
                let (cx, cy) = if cmd.eq_ignore_ascii_case(&'Q') {
                    (ox + num(), oy + num())
                } else if smooth("qt") {
                    (2.0 * px - pcx, 2.0 * py - pcy)
                } else {
                    (px, py)
                };
                let (ex, ey) = (ox + num(), oy + num());
                out.extend([3.0, cx, cy, ex, ey]);
                (pcx, pcy, px, py) = (cx, cy, ex, ey);
            }
            'A' => {
                let (rx, ry, rot, large, sweep) = (num(), num(), num() * PI / 180.0, num(), num());
                let (ex, ey) = (ox + num(), oy + num());
                svg_arc(&mut out, [px, py, rx, ry, rot, large, sweep, ex, ey]);
                (px, py) = (ex, ey);
            }
            'Z' => {
                out.push(5.0);
                (px, py) = (sx, sy);
            }
            _ => break,
        }
        last = Some(cmd);
        // (…a stray number after `Z` consumes nothing: stop rather than loop)
        if i == before {
            break;
        }
    }
    out
}
enum Tok {
    Cmd(char),
    Num(f64),
}
// A path string's tokens: each command letter, and each number (`-1.5e3`, `.5`, `1.`, the two of `1.5.5`).
fn svg_tokens(d: &str) -> Vec<Tok> {
    let b = d.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphabetic() && !matches!(c, b'e' | b'E') {
            out.push(Tok::Cmd(c as char));
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        if j < b.len() && matches!(b[j], b'+' | b'-') {
            j += 1;
        }
        let int_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let mut digits = j > int_start;
        if j < b.len() && b[j] == b'.' {
            let frac_start = j + 1;
            let mut k = frac_start;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > frac_start || digits {
                digits = true;
                j = k;
            }
        }
        if !digits {
            i = start + 1;
            continue;
        }
        if j < b.len() && matches!(b[j], b'e' | b'E') {
            let mut k = j + 1;
            if k < b.len() && matches!(b[k], b'+' | b'-') {
                k += 1;
            }
            let exp_start = k;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > exp_start {
                j = k;
            }
        }
        out.push(Tok::Num(d[start..j].parse().unwrap_or(f64::NAN)));
        i = j;
    }
    out
}
// An SVG arc in endpoint form (SVG 2 §B.2.4) as the ellipse() call that draws it, or a line where a radius is zero.
fn svg_arc(out: &mut Vec<f64>, p: [f64; 9]) {
    let [x0, y0, rx, ry, rot, large, sweep, x, y] = p;
    if rx == 0.0 || ry == 0.0 {
        out.extend([1.0, x, y]);
        return;
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    let (cos, sin) = (rot.cos(), rot.sin());
    let (dx, dy) = ((x0 - x) / 2.0, (y0 - y) / 2.0);
    let (x1, y1) = (cos * dx + sin * dy, -sin * dx + cos * dy);
    let lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let sign = if large != sweep { 1.0 } else { -1.0 };
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let co = sign * (num.max(0.0) / den).sqrt();
    let (cx1, cy1) = (co * rx * y1 / ry, -co * ry * x1 / rx);
    let (cx, cy) = (cos * cx1 - sin * cy1 + (x0 + x) / 2.0, sin * cx1 + cos * cy1 + (y0 + y) / 2.0);
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let d = ((ux * ux + uy * uy) * (vx * vx + vy * vy)).sqrt();
        let a = ((ux * vx + uy * vy) / d).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 { -a } else { a }
    };
    let theta = ang(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut d_theta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    let sweep = sweep != 0.0;
    if !sweep && d_theta > 0.0 {
        d_theta -= TAU;
    } else if sweep && d_theta < 0.0 {
        d_theta += TAU;
    }
    out.extend([4.0, cx, cy, rx, ry, rot, theta, theta + d_theta, f64::from(u8::from(!sweep))]);
}

// ── a path, as the page side hands it over ──
// `[a, b, c, d, e, f, baked, …subpaths]`, each subpath `[closed, count, x, y, …]`: the CTM, and the path's points —
// in device space already where `baked` (the context's own path, transformed as each point was added), else in user
// space (a Path2D, or a rectangle), which the CTM maps.
pub(crate) struct Path {
    ctm: Matrix,
    baked: bool,
    subs: Vec<(bool, Ring)>,
}

impl Path {
    pub(crate) fn parse(flat: &[f64]) -> Option<(Path, &[f64])> {
        let ctm: Matrix = flat.get(..6)?.try_into().ok()?;
        let baked = *flat.get(6)? != 0.0;
        let mut subs = Vec::new();
        let mut k = 7;
        while k + 1 < flat.len() {
            let (closed, n) = (flat[k] != 0.0, flat[k + 1] as usize);
            let pts = flat.get(k + 2..k + 2 + 2 * n)?;
            subs.push((closed, pts.chunks_exact(2).map(|p| (p[0], p[1])).collect()));
            k += 2 + 2 * n;
        }
        Some((Path { ctm, baked, subs }, &flat[k.min(flat.len())..]))
    }

    // The rings a fill covers: every subpath of two points or more (implicitly closed), in device space.
    pub(crate) fn fill_rings(&self) -> Vec<Ring> {
        let subs = self.subs.iter().filter(|(_, pts)| pts.len() >= 2);
        if self.baked {
            return subs.map(|(_, pts)| pts.clone()).collect();
        }
        subs.map(|(_, pts)| pts.iter().map(|&(x, y)| apply(&self.ctm, x, y)).collect()).collect()
    }

    // The rings a stroke with `pen` covers, in device space, every one wound the same way so their nonzero fill is
    // their union (a translucent stroke darkens no corner). The pen works in user space — a non-uniform CTM gives an
    // elliptical pen — so a baked path's points go back through the CTM inverted first: the pen is the CURRENT
    // transform's, whatever the path was built under. A singular CTM strokes nothing.
    pub(crate) fn stroke_rings(&self, pen: &Pen) -> Vec<Ring> {
        let mut rings = Vec::new();
        let back = if self.baked {
            let Some(inv) = invert(&self.ctm) else { return rings };
            Some(inv)
        } else {
            None
        };
        let stroker = Stroker { m: self.ctm, half: pen.width / 2.0, pen };
        for (closed, pts) in &self.subs {
            let pts: Ring = match &back {
                Some(inv) => pts.iter().map(|&(x, y)| apply(inv, x, y)).collect(),
                None => pts.clone(),
            };
            if pts.len() < 2 {
                continue;
            }
            if pen.dash.is_empty() {
                stroker.polyline(&mut rings, &pts, *closed);
            } else {
                for (piece, piece_closed) in dash_polyline(&pts, *closed, &pen.dash, pen.dash_offset) {
                    stroker.polyline(&mut rings, &piece, piece_closed);
                }
            }
        }
        for ring in &mut rings {
            if signed_area(ring) < 0.0 {
                ring.reverse();
            }
        }
        rings
    }

    pub(crate) fn singular(&self) -> bool {
        invert(&self.ctm).is_none()
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Cap {
    Butt,
    Round,
    Square,
}
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Join {
    Miter,
    Round,
    Bevel,
}
// A stroke's pen: `[width, cap, join, miterLimit, dashOffset, count, …dashes]` — cap 0 butt / 1 round / 2 square,
// join 0 miter / 1 round / 2 bevel.
pub(crate) struct Pen {
    width: f64,
    cap: Cap,
    join: Join,
    miter_limit: f64,
    dash: Vec<f64>,
    dash_offset: f64,
}

impl Pen {
    pub(crate) fn parse(flat: &[f64]) -> Option<(Pen, &[f64])> {
        let head = flat.get(..6)?;
        let n = head[5] as usize;
        let dash = flat.get(6..6 + n)?.to_vec();
        let pen = Pen {
            width: head[0],
            cap: match head[1] as i32 {
                1 => Cap::Round,
                2 => Cap::Square,
                _ => Cap::Butt,
            },
            join: match head[2] as i32 {
                1 => Join::Round,
                2 => Join::Bevel,
                _ => Join::Miter,
            },
            miter_limit: head[3],
            dash_offset: head[4],
            dash,
        };
        Some((pen, &flat[6 + n..]))
    }
}

struct Seg {
    p1: (f64, f64),
    p2: (f64, f64),
    ux: f64,
    uy: f64,
    nx: f64,
    ny: f64,
}

// Thickening polylines into rings: an offset quad per segment, a join at each inner (and a closed one's closing)
// vertex, a cap at each end of an open one — offsets in user space, mapped to device by `m`.
struct Stroker<'a> {
    m: Matrix,
    half: f64,
    pen: &'a Pen,
}

impl Stroker<'_> {
    fn tx(&self, x: f64, y: f64) -> (f64, f64) {
        apply(&self.m, x, y)
    }
    // A user-space circle of the pen's radius, as a 24-gon in device space.
    fn disc(&self, cx: f64, cy: f64) -> Ring {
        const N: usize = 24;
        (0..N)
            .map(|k| {
                let a = k as f64 / N as f64 * 2.0 * PI;
                self.tx(cx + a.cos() * self.half, cy + a.sin() * self.half)
            })
            .collect()
    }

    fn polyline(&self, rings: &mut Vec<Ring>, pts: &[(f64, f64)], closed: bool) {
        let n = pts.len();
        let count = if closed { n } else { n - 1 };
        let mut segs = Vec::new();
        for i in 0..count {
            let (p1, p2) = (pts[i], pts[(i + 1) % n]);
            let (dx, dy) = (p2.0 - p1.0, p2.1 - p1.1);
            let len = dx.hypot(dy);
            // (…a repeated point is no segment)
            if len == 0.0 {
                continue;
            }
            let (ux, uy) = (dx / len, dy / len);
            let (nx, ny) = (-uy * self.half, ux * self.half);
            rings.push(vec![
                self.tx(p1.0 + nx, p1.1 + ny),
                self.tx(p2.0 + nx, p2.1 + ny),
                self.tx(p2.0 - nx, p2.1 - ny),
                self.tx(p1.0 - nx, p1.1 - ny),
            ]);
            segs.push(Seg { p1, p2, ux, uy, nx, ny });
        }
        if segs.is_empty() {
            return;
        }
        let joins = if closed { segs.len() } else { segs.len() - 1 };
        for i in 0..joins {
            self.join(rings, &segs[i], &segs[(i + 1) % segs.len()]);
        }
        if !closed {
            self.cap(rings, &segs[0], true);
            self.cap(rings, &segs[segs.len() - 1], false);
        }
    }

    // The wedge at the vertex between `a` and `b`, on the outer side of the turn.
    fn join(&self, rings: &mut Vec<Ring>, a: &Seg, b: &Seg) {
        let v = a.p2;
        if self.pen.join == Join::Round {
            rings.push(self.disc(v.0, v.1));
            return;
        }
        let cross = a.ux * b.uy - a.uy * b.ux;
        // (…collinear segments leave no gap)
        if cross.abs() < 1e-9 {
            return;
        }
        let s = if cross < 0.0 { 1.0 } else { -1.0 };
        let o1 = (v.0 + s * a.nx, v.1 + s * a.ny);
        let o2 = (v.0 + s * b.nx, v.1 + s * b.ny);
        rings.push(vec![self.tx(o1.0, o1.1), self.tx(o2.0, o2.1), self.tx(v.0, v.1)]);
        if self.pen.join == Join::Bevel {
            return;
        }
        let Some(apex) = line_intersect(o1, (a.ux, a.uy), o2, (b.ux, b.uy)) else { return };
        // (…a miter longer than miterLimit × the width stays a bevel)
        if (apex.0 - v.0).hypot(apex.1 - v.1) / self.half > self.pen.miter_limit {
            return;
        }
        rings.push(vec![self.tx(o1.0, o1.1), self.tx(apex.0, apex.1), self.tx(o2.0, o2.1)]);
    }

    // The cap at `seg`'s start (`at_start`) or end.
    fn cap(&self, rings: &mut Vec<Ring>, seg: &Seg, at_start: bool) {
        let p = if at_start { seg.p1 } else { seg.p2 };
        let sign = if at_start { -1.0 } else { 1.0 };
        let (ux, uy) = (sign * seg.ux * self.half, sign * seg.uy * self.half);
        match self.pen.cap {
            Cap::Butt => {}
            Cap::Round => rings.push(self.disc(p.0, p.1)),
            Cap::Square => {
                let (c1, c2) = ((p.0 + seg.nx, p.1 + seg.ny), (p.0 - seg.nx, p.1 - seg.ny));
                rings.push(vec![self.tx(c1.0, c1.1), self.tx(c1.0 + ux, c1.1 + uy), self.tx(c2.0 + ux, c2.1 + uy), self.tx(c2.0, c2.1)]);
            }
        }
    }
}

// Where the line through `p` along `d1` meets the one through `q` along `d2`; None for (nearly) parallel ones.
fn line_intersect(p: (f64, f64), d1: (f64, f64), q: (f64, f64), d2: (f64, f64)) -> Option<(f64, f64)> {
    let den = d1.0 * d2.1 - d1.1 * d2.0;
    if den.abs() < 1e-9 {
        return None;
    }
    let t = ((q.0 - p.0) * d2.1 - (q.1 - p.1) * d2.0) / den;
    Some((p.0 + d1.0 * t, p.1 + d1.1 * t))
}

// Twice a ring's signed area: its sign is its winding.
fn signed_area(ring: &[(f64, f64)]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i].0 * ring[(i + 1) % n].1 - ring[(i + 1) % n].0 * ring[i].1).sum()
}

const MAX_DASHES: f64 = 1_000_000.0;

// A polyline cut into the "on" pieces of a dash pattern (`dashes`, on / off lengths, shifted by `offset`), each with
// whether it is closed. A closed polyline includes its closing edge, and a dash across its start is one piece (a join
// there, not two caps) — the whole loop, closed, where it is one "on" run. A zero-length "on" run is dropped.
fn dash_polyline(pts: &[(f64, f64)], closed: bool, dashes: &[f64], offset: f64) -> Vec<(Ring, bool)> {
    let pattern: f64 = dashes.iter().sum();
    let mut verts = pts.to_vec();
    if closed {
        verts.push(pts[0]);
    }
    // (…and a pattern so fine the path would break into more than a million dashes is stroked whole, as Skia
    // refuses one too — rather than grow the pieces until the process runs out of memory)
    let length: f64 = verts.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum();
    if pattern <= 0.0 || !(length / pattern * dashes.len() as f64 <= MAX_DASHES) {
        return vec![(verts, closed)];
    }
    let mut phase = (offset % pattern + pattern) % pattern;
    let mut di = 0;
    while phase >= dashes[di] {
        phase -= dashes[di];
        di = (di + 1) % dashes.len();
    }
    let start_on = di % 2 == 0;
    let (mut on, mut remain) = (start_on, dashes[di] - phase);
    let mut pieces: Vec<(Ring, bool)> = Vec::new();
    let mut cur: Option<Ring> = on.then(|| vec![verts[0]]);
    for s in 0..verts.len() - 1 {
        let ((ax, ay), (bx, by)) = (verts[s], verts[s + 1]);
        let len = (bx - ax).hypot(by - ay);
        if len == 0.0 {
            continue;
        }
        let (ux, uy) = ((bx - ax) / len, (by - ay) / len);
        let mut t = 0.0;
        while len - t > 1e-9 {
            let step = remain.min(len - t);
            t += step;
            remain -= step;
            let p = (ax + ux * t, ay + uy * t);
            if on {
                if let Some(c) = cur.as_mut() {
                    c.push(p);
                }
            }
            if remain <= 1e-9 {
                if on {
                    if let Some(c) = cur.take().filter(|c| c.len() >= 2) {
                        pieces.push((c, false));
                    }
                }
                di = (di + 1) % dashes.len();
                on = !on;
                remain = dashes[di];
                cur = on.then(|| vec![p]);
            }
        }
    }
    // A run "on" at the last vertex ends at the seam; where the pattern is also "on" leaving it, the two are one.
    let seam_end = on && cur.as_ref().is_some_and(|c| c.len() >= 2);
    if seam_end {
        pieces.push((cur.take().unwrap(), false));
    }
    if closed && start_on && seam_end {
        if pieces.len() > 1 {
            let (mut tail, _) = pieces.pop().unwrap();
            tail.pop();
            tail.extend(pieces[0].0.drain(..));
            pieces[0].0 = tail;
        } else {
            pieces[0].1 = true;
        }
    }
    pieces
}

// Whether (x, y) is inside the rings — by a horizontal ray's crossings, even-odd or nonzero — or on the edge of one
// that encloses any area (a point on a path's boundary is inside it; a bare line or a repeated point encloses none).
pub(crate) fn contains(rings: &[Ring], x: f64, y: f64, even_odd: bool) -> bool {
    let (mut wind, mut crossings) = (0, 0);
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let (p1, p2) = (ring[i], ring[(i + 1) % n]);
            if ((p1.1 <= y && p2.1 > y) || (p2.1 <= y && p1.1 > y)) && p1.0 + (y - p1.1) / (p2.1 - p1.1) * (p2.0 - p1.0) > x {
                crossings += 1;
                wind += if p2.1 > p1.1 { 1 } else { -1 };
            }
        }
    }
    let inside = if even_odd { crossings % 2 == 1 } else { wind != 0 };
    inside
        || rings.iter().filter(|ring| signed_area(ring) != 0.0).any(|ring| {
            let n = ring.len();
            (0..n).any(|i| dist_to_segment(x, y, ring[i], ring[(i + 1) % n]) <= 1e-6)
        })
}
fn dist_to_segment(px: f64, py: f64, p1: (f64, f64), p2: (f64, f64)) -> f64 {
    let (vx, vy) = (p2.0 - p1.0, p2.1 - p1.1);
    let len2 = vx * vx + vy * vy;
    let t = if len2 != 0.0 { (((px - p1.0) * vx + (py - p1.1) * vy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    (px - (p1.0 + t * vx)).hypot(py - (p1.1 + t * vy))
}

// ── the ops ──
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "canvasCurve", canvas_curve, context_id);
    crate::dom::register(scope, ns, "canvasArcTo", canvas_arc_to, context_id);
    crate::dom::register(scope, ns, "canvasSvgPath", canvas_svg_path, context_id);
    crate::dom::register(scope, ns, "canvasHit", canvas_hit, context_id);
}

fn numbers<const N: usize>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, from: i32) -> [f64; N] {
    std::array::from_fn(|k| args.get(from + k as i32).number_value(scope).unwrap_or(f64::NAN))
}

// __dom.canvasCurve(kind, scale, x0, y0, …) -> the flattened points after the current point (x0, y0), flat: kind 0 a
// cubic Bézier (c1x, c1y, c2x, c2y, x, y), 1 a quadratic one (cx, cy, x, y); 2 an elliptical arc's points from its
// start (`cx, cy, rx, ry, rotation, a0, a1, ccw`, no current point).
fn canvas_curve(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).int32_value(scope).unwrap_or(-1);
    let scale = args.get(1).number_value(scope).unwrap_or(1.0);
    let pts = match kind {
        0 => cubic(numbers(scope, &args, 2), scale),
        1 => quadratic(numbers(scope, &args, 2), scale),
        2 => arc(numbers(scope, &args, 2), scale),
        _ => Vec::new(),
    };
    let flat: Vec<f64> = pts.into_iter().flat_map(|(x, y)| [x, y]).collect();
    rv.set(crate::dom::f64_array(scope, &flat).into());
}

// __dom.canvasArcTo(x0, y0, x1, y1, x2, y2, r) -> arcTo's corner (`arc_to`), empty for a straight line to (x1, y1).
fn canvas_arc_to(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let corner = arc_to(numbers(scope, &args, 0));
    rv.set(crate::dom::f64_array(scope, &corner).into());
}

// __dom.canvasSvgPath(d) -> the calls SVG path data makes (`svg_path`).
fn canvas_svg_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let d = args.get(0).to_rust_string_lossy(scope);
    rv.set(crate::dom::f64_array(scope, &svg_path(&d)).into());
}

// __dom.canvasHit(shape, x, y) -> whether the point (canvas coordinates) is in the shape: `[1, evenOdd, …path]` a
// fill (isPointInPath), `[3, …pen, …path]` a stroke (isPointInStroke). Nothing is under a singular CTM, which
// collapses every shape to a line.
fn canvas_hit(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let shape = crate::dom::f64_arg(args.get(0)).to_vec();
    let [x, y] = numbers(scope, &args, 1);
    let hit = || -> Option<bool> {
        if !x.is_finite() || !y.is_finite() {
            return Some(false);
        }
        match *shape.first()? as i32 {
            1 => {
                let (path, _) = Path::parse(shape.get(2..)?)?;
                Some(!path.singular() && contains(&path.fill_rings(), x, y, shape[1] != 0.0))
            }
            3 => {
                let (pen, rest) = Pen::parse(&shape[1..])?;
                let (path, _) = Path::parse(rest)?;
                Some(!path.singular() && contains(&path.stroke_rings(&pen), x, y, false))
            }
            _ => None,
        }
    };
    rv.set_bool(hit().unwrap_or(false));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_path_data() {
        let toks: Vec<f64> = svg_tokens("M1.5.5-2e1,3L.5 1.").iter().map(|t| if let Tok::Num(v) = t { *v } else { f64::INFINITY }).collect();
        assert_eq!(toks, vec![f64::INFINITY, 1.5, 0.5, -20.0, 3.0, f64::INFINITY, 0.5, 1.0]);
    }

    #[test]
    fn reads_path_data() {
        assert_eq!(svg_path("M10 10 h5 v5 z"), vec![0.0, 10.0, 10.0, 1.0, 15.0, 10.0, 1.0, 15.0, 15.0, 5.0]);
        assert_eq!(svg_path("M0 0 L1 1 2 2"), vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 2.0, 2.0]);
        assert_eq!(svg_path("M0 0 Q1 1 2 0 T4 0"), vec![0.0, 0.0, 0.0, 3.0, 1.0, 1.0, 2.0, 0.0, 3.0, 3.0, -1.0, 4.0, 0.0]);
        assert_eq!(svg_path("5 5"), Vec::<f64>::new());
    }

    #[test]
    fn dashes_a_closed_square_across_its_seam() {
        let sq = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)];
        let pieces = dash_polyline(&sq, true, &[3.0, 1.0], 1.0);
        // The run that reaches the seam (15..16, up the left side) and the one that leaves it (0..2) are one piece.
        assert_eq!(pieces[0].0.first(), Some(&(0.0, 1.0)));
        assert_eq!(pieces[0].0.last(), Some(&(2.0, 0.0)));
    }

    #[test]
    fn finds_a_point_on_a_stroke() {
        let flat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 5.0, 10.0, 5.0];
        let (path, _) = Path::parse(&flat).unwrap();
        let pen = Pen { width: 2.0, cap: Cap::Butt, join: Join::Miter, miter_limit: 10.0, dash: Vec::new(), dash_offset: 0.0 };
        let rings = path.stroke_rings(&pen);
        assert!(contains(&rings, 5.0, 5.5, false));
        assert!(!contains(&rings, 5.0, 6.5, false));
        assert!(!contains(&rings, -0.5, 5.0, false));
    }
}
