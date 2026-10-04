// The 2D canvas's paths (HTML §4.12.5.1.6, building paths; §4.12.5.1.8, drawing paths): curves and arcs flattened to
// the points a path keeps, SVG path data read into the calls that build it (Path2D's constructor), a path's points in
// device space for a fill, the outline a stroke paints (its dash pattern, joins and caps), and whether a point is in a
// path or on its stroke. The page side keeps a path's points; every computation on them is here.

use smallvec::SmallVec;
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
// the last control point; an arc in endpoint form converted to its centre), flat: each a building op (`OP_MOVE_TO`,
// `OP_LINE_TO`, `OP_CUBIC`, `OP_QUADRATIC`, `OP_ELLIPSE`, `OP_CLOSE`) and its numbers. It stops at the first token that
// makes no sense, and before a segment short of a number (SVG 2 §9.5.4: rendering stops before the segment in error).
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
        let (mark, mut short) = (out.len(), false);
        let mut num = || match toks.get(i) {
            Some(&Tok::Num(v)) => {
                i += 1;
                v
            }
            _ => {
                short = true;
                f64::NAN
            }
        };
        let (ox, oy) = if cmd.is_ascii_lowercase() { (px, py) } else { (0.0, 0.0) };
        let smooth = |kinds: &str| last.is_some_and(|c| kinds.contains(c.to_ascii_lowercase()));
        match cmd.to_ascii_uppercase() {
            'M' => {
                px = ox + num();
                py = oy + num();
                out.extend([OP_MOVE_TO as f64, px, py]);
                (sx, sy) = (px, py);
            }
            'L' => {
                px = ox + num();
                py = oy + num();
                out.extend([OP_LINE_TO as f64, px, py]);
            }
            'H' => {
                px = ox + num();
                out.extend([OP_LINE_TO as f64, px, py]);
            }
            'V' => {
                py = oy + num();
                out.extend([OP_LINE_TO as f64, px, py]);
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
                out.extend([OP_CUBIC as f64, c1x, c1y, c2x, c2y, ex, ey]);
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
                out.extend([OP_QUADRATIC as f64, cx, cy, ex, ey]);
                (pcx, pcy, px, py) = (cx, cy, ex, ey);
            }
            'A' => {
                let (rx, ry, rot, large, sweep) = (num(), num(), num() * PI / 180.0, num(), num());
                let (ex, ey) = (ox + num(), oy + num());
                svg_arc(&mut out, [px, py, rx, ry, rot, large, sweep, ex, ey]);
                (px, py) = (ex, ey);
            }
            'Z' => {
                out.push(OP_CLOSE as f64);
                (px, py) = (sx, sy);
            }
            _ => break,
        }
        if short {
            out.truncate(mark);
            break;
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
        out.extend([OP_LINE_TO as f64, x, y]);
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
    out.extend([OP_ELLIPSE as f64, cx, cy, rx, ry, rot, theta, theta + d_theta, f64::from(u8::from(!sweep))]);
}

// ── a path being built ──
// The page side holds a path as one Float64Array, which the building ops write in place: `[len, cx, cy, cur,
// …subpaths]` — the length in use, the current point in USER space (what the curve and arc math starts from), and the
// offset of the subpath the next point joins (-1 where there is none, so no current point) — each subpath `[closed,
// count, x, y, …]`, its points in their STORED form: device space for a context's own path (the CTM as each point was
// added, baked in — a later transform does not move a point already in the path), user space for a Path2D (the
// consuming context's CTM maps it at paint time). An op that outgrows the array writes a bigger one.
const HEAD: usize = 4;

struct Builder<'a> {
    // The array as handed over, its first `len` in use; what the op adds goes to `tail`, after them.
    old: &'a mut [f64],
    len: usize,
    tail: SmallVec<[f64; 16]>,
    cx: f64,
    cy: f64,
    cur: Option<usize>,
    // The CTM each added point is baked through (a context's own path).
    ctm: Option<Matrix>,
}

impl<'a> Builder<'a> {
    // A builder over `old` — a fresh empty path where it holds none. The array is the page's own (a Path2D's `_buf`
    // is an ordinary property), so nothing in it is trusted to index by: a current subpath is taken only where its
    // header and a point lie in the length in use, and is otherwise none.
    fn new(old: &'a mut [f64], ctm: Option<Matrix>) -> Builder<'a> {
        let len = used(old);
        if len < HEAD {
            return Builder { old, len: 0, tail: SmallVec::from_elem(0.0, HEAD), cx: 0.0, cy: 0.0, cur: None, ctm };
        }
        let cur = (old[3] >= HEAD as f64 && old[3] + 3.0 < len as f64).then_some(old[3] as usize);
        let (cx, cy) = (old[1], old[2]);
        Builder { old, len, tail: SmallVec::new(), cx, cy, cur, ctm }
    }
    // The flattening resolution of the CTM's scale: a curve stays smooth in device pixels.
    fn scale(&self) -> f64 {
        self.ctm.map_or(1.0, |m| match m[0].hypot(m[1]).max(m[2].hypot(m[3])) {
            s if s > 0.0 => s,
            _ => 1.0,
        })
    }
    fn slot(&mut self, off: usize) -> &mut f64 {
        if off < self.len { &mut self.old[off] } else { &mut self.tail[off - self.len] }
    }
    fn end(&self) -> usize {
        self.len + self.tail.len()
    }

    // Write what the op built: in place where it fits, else into a new array returned (twice the room, so a path
    // built a point at a time is copied a logarithmic number of times).
    fn finish(self) -> Option<Vec<f64>> {
        let end = self.end();
        let head = [end as f64, self.cx, self.cy, self.cur.map_or(-1.0, |c| c as f64)];
        if end <= self.old.len() {
            self.old[self.len..end].copy_from_slice(&self.tail);
            self.old[..HEAD].copy_from_slice(&head);
            return None;
        }
        let mut out = Vec::with_capacity((self.old.len() * 2).max(end).max(64));
        out.extend_from_slice(&self.old[..self.len]);
        out.extend_from_slice(&self.tail);
        out[..HEAD].copy_from_slice(&head);
        out.resize(out.capacity(), 0.0);
        Some(out)
    }

    // Add a user-space point to the current subpath, in its stored form.
    fn store(&mut self, x: f64, y: f64) {
        let (x, y) = self.ctm.map_or((x, y), |m| apply(&m, x, y));
        self.tail.extend([x, y]);
        let c = self.cur.expect("a subpath to add to");
        *self.slot(c + 1) += 1.0;
    }
    // Start a new subpath at (x, y), the current point.
    fn move_to(&mut self, x: f64, y: f64) {
        self.cur = Some(self.end());
        self.tail.extend([0.0, 0.0]);
        self.store(x, y);
        (self.cx, self.cy) = (x, y);
    }
    // "Ensure there is a subpath for (x, y)": where there is no current point, one is started there.
    fn ensure(&mut self, x: f64, y: f64) {
        if self.cur.is_none() {
            self.move_to(x, y);
        }
    }
    fn line_to(&mut self, x: f64, y: f64) {
        if self.cur.is_none() {
            return self.move_to(x, y);
        }
        self.store(x, y);
        (self.cx, self.cy) = (x, y);
    }
    // Mark the current subpath closed, and start the next at its first point — the point as STORED, not re-baked
    // through a CTM that may have changed since — taken back to user space for the curve math.
    fn close(&mut self) {
        let Some(c) = self.cur else { return };
        *self.slot(c) = 1.0;
        let (fx, fy) = (*self.slot(c + 2), *self.slot(c + 3));
        self.cur = Some(self.end());
        self.tail.extend([0.0, 1.0, fx, fy]);
        (self.cx, self.cy) = self.ctm.and_then(|m| invert(&m)).map_or((fx, fy), |inv| apply(&inv, fx, fy));
    }
    // A closed rectangle, leaving a new subpath at its corner.
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let start = self.end();
        self.cur = Some(start);
        self.tail.extend([1.0, 0.0]);
        for (px, py) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
            self.store(px, py);
        }
        self.move_to(x, y);
    }
    fn cubic_to(&mut self, p: [f64; 6]) {
        self.ensure(p[0], p[1]);
        for (x, y) in cubic([self.cx, self.cy, p[0], p[1], p[2], p[3], p[4], p[5]], self.scale()) {
            self.store(x, y);
        }
        (self.cx, self.cy) = (p[4], p[5]);
    }
    fn quadratic_to(&mut self, p: [f64; 4]) {
        self.ensure(p[0], p[1]);
        for (x, y) in quadratic([self.cx, self.cy, p[0], p[1], p[2], p[3]], self.scale()) {
            self.store(x, y);
        }
        (self.cx, self.cy) = (p[2], p[3]);
    }
    // An elliptical arc (`arc`), joined to the current point by its first point — or starting the subpath there.
    fn arc(&mut self, p: [f64; 8]) {
        let pts = arc(p, self.scale());
        if self.cur.is_none() {
            self.move_to(pts[0].0, pts[0].1);
        }
        for &(x, y) in &pts {
            self.store(x, y);
        }
        (self.cx, self.cy) = *pts.last().expect("an arc has points");
    }
    // arcTo: the edge to the first tangent point and the arc to the second (`arc_to`), or a line to the corner.
    fn arc_to(&mut self, [x1, y1, x2, y2, r]: [f64; 5]) {
        self.ensure(x1, y1);
        let c = arc_to([self.cx, self.cy, x1, y1, x2, y2, r]);
        if c.is_empty() {
            return self.line_to(x1, y1);
        }
        self.line_to(c[0], c[1]);
        self.arc([c[2], c[3], r, r, 0.0, c[4], c[5], c[6]]);
        (self.cx, self.cy) = (c[7], c[8]);
    }
    // roundRect (§4.12.5.1.6): `radii` 1 to 4 (x, y) pairs in CSS corner order with its shorthands, a non-finite one
    // making the call nothing and a negative one a RangeError, in the order they come; scaled down together where
    // corners would overlap. A rectangle of negative width or height swaps its corners to keep them where they show, and
    // one of each winds the other way. It leaves a new subpath at (x, y), as rect() does.
    fn round_rect(&mut self, [mut x, mut y, mut w, mut h]: [f64; 4], radii: &[(f64, f64)]) -> Result<(), Refusal> {
        if !(1..=4).contains(&radii.len()) {
            return Err(Refusal::Range("roundRect takes one to four radii"));
        }
        for &(rx, ry) in radii {
            if !rx.is_finite() || !ry.is_finite() {
                return Ok(());
            }
            if rx < 0.0 || ry < 0.0 {
                return Err(Refusal::Range("a roundRect radius is negative"));
            }
        }
        let r = |i: usize| radii[i];
        let mut c = match radii.len() {
            1 => [r(0); 4],
            2 => [r(0), r(1), r(0), r(1)],
            3 => [r(0), r(1), r(2), r(1)],
            _ => [r(0), r(1), r(2), r(3)],
        };
        let flip = (w < 0.0) != (h < 0.0);
        if w < 0.0 {
            (x, w) = (x + w, -w);
            c = [c[1], c[0], c[3], c[2]];
        }
        if h < 0.0 {
            (y, h) = (y + h, -h);
            c = [c[3], c[2], c[1], c[0]];
        }
        // (…an edge whose corners have no radius constrains nothing; a zero-length one collapses them)
        let ratio = |num: f64, den: f64| if den > 0.0 { num / den } else { f64::INFINITY };
        let k = 1f64
            .min(ratio(w, c[0].0 + c[1].0))
            .min(ratio(w, c[3].0 + c[2].0))
            .min(ratio(h, c[0].1 + c[3].1))
            .min(ratio(h, c[1].1 + c[2].1));
        let [tl, tr, br, bl] = c.map(|(rx, ry)| (rx * k, ry * k));
        let q = PI / 2.0;
        self.move_to(x + tl.0, y);
        self.line_to(x + w - tr.0, y);
        self.arc([x + w - tr.0, y + tr.1, tr.0, tr.1, 0.0, -q, 0.0, 0.0]);
        self.line_to(x + w, y + h - br.1);
        self.arc([x + w - br.0, y + h - br.1, br.0, br.1, 0.0, 0.0, q, 0.0]);
        self.line_to(x + bl.0, y + h);
        self.arc([x + bl.0, y + h - bl.1, bl.0, bl.1, 0.0, q, PI, 0.0]);
        self.line_to(x, y + tl.1);
        self.arc([x + tl.0, y + tl.1, tl.0, tl.1, 0.0, PI, 3.0 * q, 0.0]);
        let sub = self.cur.expect("the rectangle's subpath") - self.len;
        self.close();
        if flip {
            let pts = &mut self.tail[sub + 2..self.cur.expect("the subpath after it") - self.len];
            pts.reverse();
            pts.chunks_exact_mut(2).for_each(|p| p.swap(0, 1));
        }
        self.move_to(x, y);
        Ok(())
    }

    // Append `src`'s subpaths (a path array), through `m` where given; the last of them is then the one a next point
    // joins, its last point the current point.
    fn add(&mut self, src: &[f64], m: Option<Matrix>) {
        let (len, mut k) = (used(src), HEAD);
        while k + 1 < len {
            let (closed, n) = (src[k], src[k + 1] as usize);
            let Some(pts) = src.get(k + 2..k + 2 + 2 * n) else { break };
            self.cur = Some(self.end());
            self.tail.extend([closed, n as f64]);
            for p in pts.chunks_exact(2) {
                let (x, y) = m.map_or((p[0], p[1]), |m| apply(&m, p[0], p[1]));
                self.tail.extend([x, y]);
                (self.cx, self.cy) = (x, y);
            }
            k += 2 + 2 * n;
        }
    }

    // The calls SVG path data makes (`svg_path`), made.
    fn svg(&mut self, d: &str) {
        let c = svg_path(d);
        let mut k = 0;
        while k < c.len() {
            let (op, n) = (c[k] as i32, arity(c[k] as i32));
            let _ = self.op(op, &c[k + 1..k + 1 + n]);
            k += 1 + n;
        }
    }

    // A building op (`canvasPath`'s `op`) on its arguments (`arity` of them; an anticlockwise flag 1 or 0): a
    // non-finite one makes it nothing, a negative radius refuses it.
    fn op(&mut self, op: i32, a: &[f64]) -> Result<(), Refusal> {
        let flag = usize::from(matches!(op, OP_ARC | OP_ELLIPSE));
        if !a.iter().take(arity(op) - flag).all(|v| v.is_finite()) {
            return Ok(());
        }
        let arr = |n: usize| -> &[f64] { &a[..n] };
        match op {
            OP_MOVE_TO => self.move_to(a[0], a[1]),
            OP_LINE_TO => self.line_to(a[0], a[1]),
            OP_CLOSE => self.close(),
            OP_RECT => self.rect(a[0], a[1], a[2], a[3]),
            OP_ROUND_RECT => {
                let radii: Vec<(f64, f64)> = a[4..].chunks_exact(2).map(|p| (p[0], p[1])).collect();
                self.round_rect(arr(4).try_into().expect("four"), &radii)?;
            }
            OP_CUBIC => self.cubic_to(arr(6).try_into().expect("six")),
            OP_QUADRATIC => self.quadratic_to(arr(4).try_into().expect("four")),
            OP_ARC => {
                if a[2] < 0.0 {
                    return Err(Refusal::IndexSize("the radius is negative"));
                }
                self.arc([a[0], a[1], a[2], a[2], 0.0, a[3], a[4], f64::from(u8::from(a[5] == 1.0))]);
            }
            OP_ELLIPSE => {
                if a[2] < 0.0 || a[3] < 0.0 {
                    return Err(Refusal::IndexSize("a radius is negative"));
                }
                self.arc([a[0], a[1], a[2], a[3], a[4], a[5], a[6], f64::from(u8::from(a[7] == 1.0))]);
            }
            OP_ARC_TO => {
                if a[4] < 0.0 {
                    return Err(Refusal::IndexSize("the radius is negative"));
                }
                self.arc_to(arr(5).try_into().expect("five"));
            }
            OP_RESET => {
                // (…an empty path, in the array it had)
                (self.len, self.cur, self.cx, self.cy) = (0, None, 0.0, 0.0);
                self.tail = SmallVec::from_elem(0.0, HEAD);
            }
            _ => {}
        }
        Ok(())
    }
}

// How many numbers an op takes — roundRect its rectangle, before the radii.
fn arity(op: i32) -> usize {
    match op {
        OP_MOVE_TO | OP_LINE_TO => 2,
        OP_RECT | OP_ROUND_RECT | OP_QUADRATIC => 4,
        OP_ARC_TO => 5,
        OP_CUBIC | OP_ARC => 6,
        OP_ELLIPSE => 8,
        _ => 0,
    }
}

const OP_MOVE_TO: i32 = 0;
const OP_LINE_TO: i32 = 1;
const OP_CLOSE: i32 = 2;
const OP_RECT: i32 = 3;
const OP_ROUND_RECT: i32 = 4;
const OP_CUBIC: i32 = 5;
const OP_QUADRATIC: i32 = 6;
const OP_ARC: i32 = 7;
const OP_ELLIPSE: i32 = 8;
const OP_ARC_TO: i32 = 9;
const OP_RESET: i32 = 10;

// Why an op refused its arguments: the script exception it throws.
enum Refusal {
    Range(&'static str),
    IndexSize(&'static str),
}

// The shape the rasterizer takes (`Path::parse`, after what `head` says the shape is): the CTM, whether the path
// array's points are baked through it, and its subpaths.
fn shape(head: &[f64], path: &[f64], ctm: Matrix, baked: bool) -> Vec<f64> {
    let subs = path.get(HEAD..used(path)).unwrap_or(&[]);
    let mut out = Vec::with_capacity(head.len() + 7 + subs.len());
    out.extend_from_slice(head);
    out.extend_from_slice(&ctm);
    out.push(f64::from(u8::from(baked)));
    out.extend_from_slice(subs);
    out
}
// The length of a path array in use.
fn used(path: &[f64]) -> usize {
    path.first().map_or(0, |&l| l as usize).min(path.len())
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
    crate::dom::register(scope, ns, "canvasPath", canvas_path, context_id);
    crate::dom::register(scope, ns, "canvasPathAdd", canvas_path_add, context_id);
    crate::dom::register(scope, ns, "canvasPathSvg", canvas_path_svg, context_id);
    crate::dom::register(scope, ns, "canvasPathShape", canvas_path_shape, context_id);
    crate::dom::register(scope, ns, "canvasPathEmpty", canvas_path_empty, context_id);
    crate::dom::register(scope, ns, "canvasHit", canvas_hit, context_id);
}

fn numbers<const N: usize>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, from: i32) -> [f64; N] {
    std::array::from_fn(|k| args.get(from + k as i32).number_value(scope).unwrap_or(f64::NAN))
}
// A matrix argument — an array of its six numbers — or None for anything else.
fn matrix_arg(scope: &mut v8::PinScope<'_, '_>, val: v8::Local<'_, v8::Value>) -> Option<Matrix> {
    let arr = v8::Local::<v8::Array>::try_from(val).ok()?;
    let mut m = [0.0; 6];
    for (k, v) in m.iter_mut().enumerate() {
        *v = arr.get_index(scope, k as u32)?.number_value(scope)?;
    }
    Some(m)
}
// The f64s of a path array, to write in place: ours (`f64_array`'s, aligned, offset 0) or nothing.
fn path_mut<'a>(val: v8::Local<'a, v8::Value>) -> &'a mut [f64] {
    let Ok(arr) = v8::Local::<v8::Float64Array>::try_from(val) else { return &mut [] };
    let (ptr, n) = (arr.data() as *mut f64, arr.length());
    if n == 0 || ptr.is_null() || (ptr as usize) % std::mem::align_of::<f64>() != 0 {
        return &mut [];
    }
    // SAFETY: the view's own `n` aligned f64s, valid for the op (no JS runs and nothing allocates on the V8 heap while it
    // holds them), borrowed by nothing else (an op that reads a second array copies it first).
    unsafe { std::slice::from_raw_parts_mut(ptr, n) }
}
// Hand back what a builder wrote: the bigger array it needed, or nothing where it wrote in place.
fn finish(scope: &mut v8::PinScope<'_, '_>, b: Builder<'_>, rv: &mut v8::ReturnValue<'_, v8::Value>) {
    if let Some(grown) = b.finish() {
        rv.set(crate::dom::f64_array(scope, &grown).into());
    }
}

// __dom.canvasPath(path, op, baked, a, b, c, d, e, f, …args) -> a building op on the path array (`Builder::op`; the ops
// are its `OP_` constants, in the order of `CanvasPath`'s methods, then a reset), each point baked through the CTM `a`
// to `f` where `baked`: nothing where it wrote in place, the array that replaces it where it outgrew it (or was none),
// or a refusal `[exception, message]` — "RangeError", or the DOMException's name. Every number is one already (the page
// side converts them as WebIDL does), read as such: an op is made a point at a time, and a ToNumber for each costs more
// than the op.
fn canvas_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let num = |k: i32| v8::Local::<v8::Number>::try_from(args.get(k)).map_or(f64::NAN, |n| n.value());
    let op = num(1) as i32;
    let ctm = args.get(2).is_true().then(|| std::array::from_fn(|k| num(3 + k as i32)));
    // (…the op's own arguments, missing ones NaN; roundRect's radii are the rest)
    let n = arity(op);
    let mut fixed = [f64::NAN; 8];
    let radii: Vec<f64>;
    let a: &[f64] = if op == OP_ROUND_RECT {
        radii = (9..args.length().max(9 + n as i32)).map(num).collect();
        &radii
    } else {
        fixed[..n].iter_mut().enumerate().for_each(|(k, v)| *v = num(9 + k as i32));
        &fixed[..n]
    };
    let mut b = Builder::new(path_mut(args.get(0)), ctm);
    match b.op(op, a) {
        Ok(()) => finish(scope, b, &mut rv),
        Err(refusal) => {
            let (name, message) = match refusal {
                Refusal::Range(m) => ("RangeError", m),
                Refusal::IndexSize(m) => ("IndexSizeError", m),
            };
            let parts = [name, message].map(|s| v8::String::new(scope, s).expect("a short string").into());
            rv.set(v8::Array::new_with_elements(scope, &parts).into());
        }
    }
}

// __dom.canvasPathAdd(path, other, m) -> Path2D's addPath: `other`'s subpaths appended, through the matrix `m` where it
// is one (a non-finite one adds nothing); returns as `canvasPath`.
fn canvas_path_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let m = matrix_arg(scope, args.get(2));
    if m.is_some_and(|m| !m.iter().all(|v| v.is_finite())) {
        return;
    }
    // (…copied first: a path added to itself is the same array)
    let src = crate::dom::f64_arg(args.get(1)).to_vec();
    let mut b = Builder::new(path_mut(args.get(0)), None);
    b.add(&src, m);
    finish(scope, b, &mut rv);
}

// __dom.canvasPathSvg(path, d) -> the path SVG path data `d` builds, added to `path` (Path2D's constructor); returns as
// `canvasPath`.
fn canvas_path_svg(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let d = args.get(1).to_rust_string_lossy(scope);
    let mut b = Builder::new(path_mut(args.get(0)), None);
    b.svg(&d);
    finish(scope, b, &mut rv);
}

// __dom.canvasPathShape(head, path, ctm, baked) -> the shape a path array makes under `ctm` (`shape`): `head` `[1,
// evenOdd]` its fill, `[3, …pen]` its stroke.
fn canvas_path_shape(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let head: Vec<f64> = match v8::Local::<v8::Array>::try_from(args.get(0)) {
        Ok(arr) => (0..arr.length()).map(|k| arr.get_index(scope, k).and_then(|v| v.number_value(scope)).unwrap_or(f64::NAN)).collect(),
        Err(_) => Vec::new(),
    };
    let ctm = matrix_arg(scope, args.get(2)).unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let baked = args.get(3).boolean_value(scope);
    let flat = shape(&head, &crate::dom::f64_arg(args.get(1)), ctm, baked);
    rv.set(crate::dom::f64_array(scope, &flat).into());
}

// __dom.canvasPathEmpty(path) -> whether a path array has no subpaths.
fn canvas_path_empty(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(used(&crate::dom::f64_arg(args.get(0))) <= HEAD);
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

    // A path array after `ops`, each `(op, args)` made on it in turn from an empty one, through `ctm` where given.
    fn built(ctm: Option<Matrix>, ops: &[(i32, &[f64])]) -> Vec<f64> {
        let mut buf: Vec<f64> = Vec::new();
        for &(op, a) in std::iter::once(&(10, &[][..])).chain(ops) {
            let mut a = a.to_vec();
            a.resize(a.len().max(if op == OP_ROUND_RECT { 4 } else { 8 }), f64::NAN);
            let mut b = Builder::new(&mut buf, ctm);
            assert!(b.op(op, &a).is_ok());
            if let Some(grown) = b.finish() {
                buf = grown;
            }
        }
        buf.truncate(used(&buf));
        buf
    }

    #[test]
    fn trusts_nothing_in_the_array_it_is_handed() {
        // (…the page can hand over any array: a current subpath past the length in use, or at its very end, is none)
        for cur in [100.0, 7.0, 6.0, 1e300, f64::NAN, -1.0] {
            let mut buf = vec![8.0, 0.0, 0.0, cur, 0.0, 0.0, 0.0, 0.0];
            let mut b = Builder::new(&mut buf, None);
            assert!(b.op(OP_LINE_TO, &[1.0, 1.0]).is_ok() && b.op(OP_CLOSE, &[]).is_ok());
            b.finish();
        }
    }

    #[test]
    fn builds_a_path_in_place_and_grows_it() {
        let lines: Vec<(i32, &[f64])> = std::iter::repeat_n((OP_LINE_TO, &[1.0, 2.0][..]), 100).collect();
        let path = built(None, &lines);
        assert_eq!(&path[..HEAD + 4], &[206.0, 1.0, 2.0, 4.0, 0.0, 100.0, 1.0, 2.0]);
    }

    #[test]
    fn closes_a_subpath_at_its_stored_start() {
        // (…a translated CTM baked into the points; the subpath after the close starts at the first point as stored,
        // and the current point is that one in user space)
        let path = built(Some([1.0, 0.0, 0.0, 1.0, 10.0, 0.0]), &[(OP_MOVE_TO, &[1.0, 1.0]), (OP_LINE_TO, &[2.0, 1.0]), (OP_CLOSE, &[])]);
        assert_eq!(path, vec![14.0, 1.0, 1.0, 10.0, 1.0, 2.0, 11.0, 1.0, 12.0, 1.0, 0.0, 1.0, 11.0, 1.0]);
    }

    #[test]
    fn a_flipped_round_rect_winds_the_other_way() {
        let area = |path: &[f64]| signed_area(&path[HEAD + 2..].chunks_exact(2).take(path[HEAD + 1] as usize).map(|p| (p[0], p[1])).collect::<Vec<_>>());
        let plain = built(None, &[(OP_ROUND_RECT, &[0.0, 0.0, 10.0, 10.0, 2.0, 2.0])]);
        let flipped = built(None, &[(OP_ROUND_RECT, &[10.0, 0.0, -10.0, 10.0, 2.0, 2.0])]);
        assert!(area(&plain) * area(&flipped) < 0.0);
        let mut b = Builder::new(&mut [], None);
        assert!(matches!(b.round_rect([0.0, 0.0, 1.0, 1.0], &[(f64::NAN, 0.0), (-1.0, 0.0)]), Ok(())));
        assert!(matches!(b.round_rect([0.0, 0.0, 1.0, 1.0], &[(-1.0, 0.0), (f64::NAN, 0.0)]), Err(Refusal::Range(_))));
    }

    #[test]
    fn an_added_path_is_continued_from_its_last_point() {
        let src = built(None, &[(OP_MOVE_TO, &[50.0, 50.0]), (OP_LINE_TO, &[60.0, 50.0])]);
        let mut dst = built(None, &[(OP_MOVE_TO, &[10.0, 10.0])]);
        let mut b = Builder::new(&mut dst, None);
        b.add(&src, Some([1.0, 0.0, 0.0, 1.0, 0.0, 5.0]));
        b.line_to(60.0, 70.0);
        let grown = b.finish().expect("a bigger array");
        assert_eq!(&grown[..used(&grown)], &[16.0, 60.0, 70.0, 8.0, 0.0, 1.0, 10.0, 10.0, 0.0, 3.0, 50.0, 55.0, 60.0, 55.0, 60.0, 70.0]);
    }

    #[test]
    fn tokenizes_path_data() {
        let toks: Vec<f64> = svg_tokens("M1.5.5-2e1,3L.5 1.").iter().map(|t| if let Tok::Num(v) = t { *v } else { f64::INFINITY }).collect();
        assert_eq!(toks, vec![f64::INFINITY, 1.5, 0.5, -20.0, 3.0, f64::INFINITY, 0.5, 1.0]);
    }

    #[test]
    fn reads_path_data() {
        assert_eq!(svg_path("M10 10 h5 v5 z"), vec![0.0, 10.0, 10.0, 1.0, 15.0, 10.0, 1.0, 15.0, 15.0, 2.0]);
        assert_eq!(svg_path("M0 0 L1 1 2 2"), vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 2.0, 2.0]);
        assert_eq!(svg_path("M0 0 Q1 1 2 0 T4 0"), vec![0.0, 0.0, 0.0, 6.0, 1.0, 1.0, 2.0, 0.0, 6.0, 3.0, -1.0, 4.0, 0.0]);
        assert_eq!(svg_path("5 5"), Vec::<f64>::new());
        // (…a segment short of a number is not drawn, nor anything after it)
        assert_eq!(svg_path("M0 0 L100 0 L50 L1 1"), vec![0.0, 0.0, 0.0, 1.0, 100.0, 0.0]);
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
