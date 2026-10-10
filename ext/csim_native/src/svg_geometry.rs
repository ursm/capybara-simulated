// SVG GEOMETRY (SVG 2 §8, §9, §11): where the graphics inside an outer `<svg>` are — which the layout knows nothing of,
// the `<svg>` being one replaced box to it. An element's user space maps to its outer `<svg>`'s content box through the
// viewports on the way (each `<svg>`'s `viewBox` and `preserveAspectRatio`) and every `transform` attribute; a shape's
// bounding box is its geometry's — a rect's, a circle's, a path's to its curves' extremes — and a container's the union
// of its children's. What reads it: an element's client rect (`getBoundingClientRect`), and the hit test, which finds
// the graphics element under a point inside an `<svg>` (a click on an icon reaches its `<path>`'s listener).
// Not modelled yet: text's geometry, `use` of a referenced element, stroke and markers.

use web_atoms::ns;

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};

// An affine map `[a, b, c, d, e, f]`: (x, y) → (a·x + c·y + e, b·x + d·y + f).
type Affine = [f64; 6];
const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn then(outer: &Affine, inner: &Affine) -> Affine {
    let [a, b, c, d, e, f] = *outer;
    let [g, h, i, j, k, l] = *inner;
    [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f]
}
fn apply(m: &Affine, x: f64, y: f64) -> [f64; 2] {
    [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
fn invert(m: &Affine) -> Option<Affine> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let [a, b, c, d, e, f] = *m;
    Some([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det])
}

fn is_svg(n: &NodeData) -> bool {
    n.kind == NodeKind::Element && n.ns == ns!(svg)
}
// The elements whose content is never rendered: their subtrees are templates, resources, metadata.
const NOT_RENDERED: [&str; 12] =
    ["defs", "symbol", "clipPath", "mask", "marker", "pattern", "linearGradient", "radialGradient", "filter", "title", "desc", "metadata"];
// The containers whose children are rendered: a shape's, a text's, an image's are not.
const CONTAINERS: [&str; 4] = ["svg", "g", "a", "switch"];
// The graphics elements a hit can land on.
const SHAPES: [&str; 9] = ["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "image", "foreignObject"];

// The outermost `<svg>` an SVG element is drawn in — the one the layout gives a box — where `id` is inside one, not it.
pub(crate) fn outer_svg(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let mut found = None;
    let mut at = arena.get(id).filter(|n| is_svg(n))?.parent;
    while let Some(p) = at {
        let n = arena.get(p).filter(|n| is_svg(n))?;
        if &*n.local_name == "svg" {
            found = Some(p);
        }
        match n.parent.and_then(|q| arena.get(q)) {
            Some(q) if is_svg(q) => at = n.parent,
            _ => break,
        }
    }
    found
}

// A length attribute in user units: a number, `px`, or a percentage of `basis` (the viewport's width, height, or their
// normalized diagonal); none where absent or no number.
fn length(n: &NodeData, name: &str, basis: f64) -> Option<f64> {
    let v = n.plain_attr(name)?.trim();
    if let Some(p) = v.strip_suffix('%') {
        return p.trim().parse::<f64>().ok().map(|p| p / 100.0 * basis);
    }
    v.strip_suffix("px").unwrap_or(v).trim().parse::<f64>().ok().filter(|v| v.is_finite())
}
// …and the numbers of a list attribute (`viewBox`, `points`), commas or white space between.
fn numbers(s: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let mut scan = Scanner { s: s.as_bytes(), i: 0 };
    while let Some(v) = scan.number() {
        out.push(v);
    }
    out
}

// The map a viewport — its size `w` x `h` — makes of the user space its `viewBox` gives (`preserveAspectRatio`'s align
// and meet or slice), the identity where it has none.
fn viewbox_map(n: &NodeData, w: f64, h: f64) -> (Affine, [f64; 2]) {
    let vb = n.plain_attr("viewBox").map(numbers).filter(|v| v.len() == 4 && v[2] > 0.0 && v[3] > 0.0);
    let Some(vb) = vb else { return (IDENTITY, [w, h]) };
    let (sx, sy) = (w / vb[2], h / vb[3]);
    let par = n.plain_attr("preserveAspectRatio").unwrap_or("xMidYMid meet");
    let mut words = par.split_ascii_whitespace();
    let align = words.next().unwrap_or("xMidYMid");
    if align == "none" {
        return ([sx, 0.0, 0.0, sy, -vb[0] * sx, -vb[1] * sy], [vb[2], vb[3]]);
    }
    let s = if words.next() == Some("slice") { sx.max(sy) } else { sx.min(sy) };
    let offset = |pos: &str, avail: f64, used: f64| match pos {
        "Min" => 0.0,
        "Max" => avail - used,
        _ => (avail - used) / 2.0,
    };
    let (xa, ya) = (align.get(1..4).unwrap_or("Mid"), align.get(5..8).unwrap_or("Mid"));
    let (tx, ty) = (offset(xa, w, vb[2] * s), offset(ya, h, vb[3] * s));
    ([s, 0.0, 0.0, s, tx - vb[0] * s, ty - vb[1] * s], [vb[2], vb[3]])
}

// A `transform` attribute's list, composed left to right.
fn transform_attr(n: &NodeData) -> Affine {
    let Some(s) = n.plain_attr("transform") else { return IDENTITY };
    let mut m = IDENTITY;
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let name = rest[..open].trim_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        let Some(close) = rest[open..].find(')') else { break };
        let args = numbers(&rest[open + 1..open + close]);
        rest = &rest[open + close + 1..];
        let arg = |i: usize, or: f64| args.get(i).copied().unwrap_or(or);
        let step: Affine = match name {
            "matrix" if args.len() == 6 => [args[0], args[1], args[2], args[3], args[4], args[5]],
            "translate" => [1.0, 0.0, 0.0, 1.0, arg(0, 0.0), arg(1, 0.0)],
            "scale" => [arg(0, 1.0), 0.0, 0.0, arg(1, arg(0, 1.0)), 0.0, 0.0],
            "rotate" => {
                let (s, c) = arg(0, 0.0).to_radians().sin_cos();
                let rot = [c, s, -s, c, 0.0, 0.0];
                let (cx, cy) = (arg(1, 0.0), arg(2, 0.0));
                then(&then(&[1.0, 0.0, 0.0, 1.0, cx, cy], &rot), &[1.0, 0.0, 0.0, 1.0, -cx, -cy])
            }
            "skewX" => [1.0, 0.0, arg(0, 0.0).to_radians().tan(), 1.0, 0.0, 0.0],
            "skewY" => [1.0, arg(0, 0.0).to_radians().tan(), 0.0, 1.0, 0.0, 0.0],
            _ => return IDENTITY,
        };
        m = then(&m, &step);
    }
    m
}

// The outer `<svg>`'s content box in viewport coordinates — its layout box less its borders and padding — and its
// transform chain.
fn content_box(arena: &RealmArena, svg: NodeId) -> Option<[f64; 4]> {
    let [x, y, w, h] = crate::geometry::laid_out_box(arena, svg)?;
    let e = crate::geometry::edges(arena, svg).unwrap_or([0.0; 12]);
    // (…its edges padding, border and margin, each top / right / bottom / left)
    Some([x + e[7] + e[3], y + e[4] + e[0], (w - e[5] - e[7] - e[1] - e[3]).max(0.0), (h - e[4] - e[6] - e[0] - e[2]).max(0.0)])
}

// The map from `id`'s user space — its own `transform` applied — to its outer `<svg>`'s content box, and the size of
// the viewport its lengths' percentages are of.
fn user_map(arena: &RealmArena, id: NodeId, outer: NodeId) -> Option<(Affine, [f64; 2])> {
    let [_, _, w, h] = content_box(arena, outer)?;
    if id == outer {
        return Some(viewbox_map(arena.get(outer)?, w, h));
    }
    // (…each ancestor on the way a container, whose children are rendered — a `<path>` in a `<rect>` is none)
    let mut chain = vec![id];
    let mut at = arena.get(id)?.parent;
    while let Some(p) = at.filter(|&p| p != outer) {
        let n = arena.get(p)?;
        if !CONTAINERS.contains(&&*n.local_name) {
            return None;
        }
        chain.push(p);
        at = n.parent;
    }
    let (mut m, mut vp) = viewbox_map(arena.get(outer)?, w, h);
    for &el in chain.iter().rev() {
        let n = arena.get(el)?;
        if &*n.local_name == "svg" {
            let (x, y) = (length(n, "x", vp[0]).unwrap_or(0.0), length(n, "y", vp[1]).unwrap_or(0.0));
            let (iw, ih) = (length(n, "width", vp[0]).unwrap_or(vp[0]), length(n, "height", vp[1]).unwrap_or(vp[1]));
            let (inner, size) = viewbox_map(n, iw, ih);
            m = then(&then(&m, &[1.0, 0.0, 0.0, 1.0, x, y]), &inner);
            vp = size;
        } else {
            m = then(&m, &transform_attr(n));
        }
    }
    Some((m, vp))
}

// The bounding box of `id`'s geometry in its user space, `[x0, y0, x1, y1]` (its own transform not applied): a shape's,
// or a container's — the union of its rendered children's, each under its own transform. None where it has none.
fn local_bbox(arena: &RealmArena, id: NodeId, vp: [f64; 2]) -> Option<[f64; 4]> {
    let n = arena.get(id).filter(|n| is_svg(n))?;
    let diag = vp[0].hypot(vp[1]) / std::f64::consts::SQRT_2;
    let len = |name: &str, basis: f64| length(n, name, basis).unwrap_or(0.0);
    let r = |x0: f64, y0: f64, x1: f64, y1: f64| Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]);
    match &*n.local_name {
        "rect" | "image" | "foreignObject" => {
            let (x, y) = (len("x", vp[0]), len("y", vp[1]));
            r(x, y, x + len("width", vp[0]).max(0.0), y + len("height", vp[1]).max(0.0))
        }
        "circle" => {
            let (cx, cy, rr) = (len("cx", vp[0]), len("cy", vp[1]), len("r", diag).max(0.0));
            r(cx - rr, cy - rr, cx + rr, cy + rr)
        }
        "ellipse" => {
            let (cx, cy, rx, ry) = (len("cx", vp[0]), len("cy", vp[1]), len("rx", vp[0]).max(0.0), len("ry", vp[1]).max(0.0));
            r(cx - rx, cy - ry, cx + rx, cy + ry)
        }
        "line" => r(len("x1", vp[0]), len("y1", vp[1]), len("x2", vp[0]), len("y2", vp[1])),
        "polyline" | "polygon" => {
            let pts = numbers(n.plain_attr("points").unwrap_or(""));
            union_points(pts.chunks_exact(2).map(|p| [p[0], p[1]]))
        }
        "path" => path_bbox(n.plain_attr("d").unwrap_or("")),
        "g" | "a" | "switch" | "svg" => {
            let (inner_vp, inner_map) = if &*n.local_name == "svg" {
                let (iw, ih) = (length(n, "width", vp[0]).unwrap_or(vp[0]), length(n, "height", vp[1]).unwrap_or(vp[1]));
                let (map, size) = viewbox_map(n, iw, ih);
                (size, then(&[1.0, 0.0, 0.0, 1.0, len("x", vp[0]), len("y", vp[1])], &map))
            } else {
                (vp, IDENTITY)
            };
            let mut out: Option<[f64; 4]> = None;
            for &c in &n.children {
                let Some(cn) = arena.get(c).filter(|cn| is_svg(cn) && !NOT_RENDERED.contains(&&*cn.local_name)) else { continue };
                let Some(b) = local_bbox(arena, c, inner_vp) else { continue };
                let m = then(&inner_map, &transform_attr(cn));
                let corners = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(|[x, y]| apply(&m, x, y));
                let Some(cb) = union_points(corners.into_iter()) else { continue };
                out = Some(match out {
                    Some(o) => [o[0].min(cb[0]), o[1].min(cb[1]), o[2].max(cb[2]), o[3].max(cb[3])],
                    None => cb,
                });
            }
            out
        }
        _ => None,
    }
}

fn union_points(points: impl Iterator<Item = [f64; 2]>) -> Option<[f64; 4]> {
    let mut out: Option<[f64; 4]> = None;
    for [x, y] in points {
        out = Some(match out {
            Some(o) => [o[0].min(x), o[1].min(y), o[2].max(x), o[3].max(y)],
            None => [x, y, x, y],
        });
    }
    out
}

// An SVG element's client rect: its bounding box under the map to the viewport — the outer `<svg>`'s content box and
// transforms — as `[x, y, w, h]`; None for one outside an outer `<svg>` with a box, or with no geometry.
// (An inner `<svg>`'s is its content's, as a `<g>`'s — Chrome — its viewport mapping its children in `local_bbox`.)
pub(crate) fn client_rect(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let outer = outer_svg(arena, id)?;
    let n = arena.get(id)?;
    let (m, b) = if &*n.local_name == "svg" {
        let (m, vp) = user_map(arena, n.parent?, outer)?;
        (m, local_bbox(arena, id, vp)?)
    } else {
        let (m, vp) = user_map(arena, id, outer)?;
        (m, local_bbox(arena, id, vp)?)
    };
    let [ox, oy, _, _] = content_box(arena, outer)?;
    let chain = crate::geometry::transform_chain(arena, outer);
    let to_viewport = |[x, y]: [f64; 2]| -> Option<[f64; 2]> {
        let [x, y] = apply(&m, x, y);
        match &chain {
            Some(t) => crate::geometry::project(t, x + ox, y + oy),
            None => Some([x + ox, y + oy]),
        }
    };
    let corners = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]];
    let pts: Vec<[f64; 2]> = corners.iter().filter_map(|&p| to_viewport(p)).collect();
    let u = union_points(pts.into_iter())?;
    Some([u[0], u[1], u[2] - u[0], u[3] - u[1]])
}

// The graphics element under the viewport point (x, y) inside the outer `<svg>` `svg` — the last in tree order, which
// paints on top — whose geometry holds it (a rect's or a path's box, a circle's or an ellipse's own disc), rendered:
// not in a resource (`<defs>`, …), shown, not `pointer-events: none`. None for the `<svg>`'s own background.
pub(crate) fn hit(arena: &RealmArena, svg: NodeId, x: f64, y: f64) -> Option<NodeId> {
    let [ox, oy, _, _] = content_box(arena, svg)?;
    let (px, py) = match crate::geometry::transform_chain(arena, svg) {
        Some(t) => {
            let inv = crate::geometry::inverse_homography(&t)?;
            let [ux, uy] = crate::geometry::project(&inv, x, y)?;
            (ux - ox, uy - oy)
        }
        None => (x - ox, y - oy),
    };
    let mut found = None;
    let mut stack: Vec<NodeId> = arena.get(svg)?.children.iter().rev().copied().collect();
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id).filter(|n| is_svg(n)) else { continue };
        if NOT_RENDERED.contains(&&*n.local_name) || !shown(arena, id) {
            continue;
        }
        if SHAPES.contains(&&*n.local_name) && hits_shape(arena, id, n, svg, px, py) && accepts_pointer(arena, id) {
            found = Some(id);
        }
        if CONTAINERS.contains(&&*n.local_name) {
            stack.extend(n.children.iter().rev());
        }
    }
    found
}
fn hits_shape(arena: &RealmArena, id: NodeId, n: &NodeData, svg: NodeId, px: f64, py: f64) -> bool {
    let Some((m, vp)) = user_map(arena, id, svg) else { return false };
    let Some([ux, uy]) = invert(&m).map(|inv| apply(&inv, px, py)) else { return false };
    let diag = vp[0].hypot(vp[1]) / std::f64::consts::SQRT_2;
    let len = |name: &str, basis: f64| length(n, name, basis).unwrap_or(0.0);
    match &*n.local_name {
        "circle" => {
            let (cx, cy, r) = (len("cx", vp[0]), len("cy", vp[1]), len("r", diag));
            (ux - cx).hypot(uy - cy) <= r
        }
        "ellipse" => {
            let (cx, cy, rx, ry) = (len("cx", vp[0]), len("cy", vp[1]), len("rx", vp[0]), len("ry", vp[1]));
            rx > 0.0 && ry > 0.0 && ((ux - cx) / rx).powi(2) + ((uy - cy) / ry).powi(2) <= 1.0
        }
        _ => local_bbox(arena, id, vp).is_some_and(|b| ux >= b[0] && ux <= b[2] && uy >= b[1] && uy <= b[3]),
    }
}
// …shown: no `display: none` and no `visibility: hidden` on it (an element the style engine does not style is shown).
fn shown(arena: &RealmArena, id: NodeId) -> bool {
    crate::style::primary_style(arena, id).is_none_or(|s| !s.get_box().clone_display().is_none())
}
fn accepts_pointer(arena: &RealmArena, id: NodeId) -> bool {
    use style::computed_values::pointer_events::T as PointerEvents;
    use style::computed_values::visibility::T as Visibility;
    !arena.is_inert(id) && crate::style::primary_style(arena, id).is_none_or(|s| {
        s.get_inherited_ui().pointer_events != PointerEvents::None && s.get_inherited_box().visibility == Visibility::Visible
    })
}

// ── path data (SVG 2 §9.3) ──────────────────────────────────────────────────────────────────────────────────────────
struct Scanner<'a> {
    s: &'a [u8],
    i: usize,
}
impl Scanner<'_> {
    fn skip(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r' | 0x0C | b',') {
            self.i += 1;
        }
    }
    fn number(&mut self) -> Option<f64> {
        self.skip();
        let start = self.i;
        let s = self.s;
        let mut i = self.i;
        if i < s.len() && matches!(s[i], b'+' | b'-') {
            i += 1;
        }
        let digits = |i: &mut usize| {
            let from = *i;
            while *i < s.len() && s[*i].is_ascii_digit() {
                *i += 1;
            }
            *i > from
        };
        let mut any = digits(&mut i);
        if i < s.len() && s[i] == b'.' {
            i += 1;
            any |= digits(&mut i);
        }
        if !any {
            return None;
        }
        if i < s.len() && matches!(s[i], b'e' | b'E') {
            let mut j = i + 1;
            if j < s.len() && matches!(s[j], b'+' | b'-') {
                j += 1;
            }
            if digits(&mut j) {
                i = j;
            }
        }
        self.i = i;
        std::str::from_utf8(&s[start..i]).ok()?.parse().ok()
    }
    // …an arc's flag: a single `0` or `1`.
    fn flag(&mut self) -> Option<bool> {
        self.skip();
        let f = match self.s.get(self.i)? {
            b'0' => false,
            b'1' => true,
            _ => return None,
        };
        self.i += 1;
        Some(f)
    }
    fn command(&mut self) -> Option<u8> {
        self.skip();
        let c = *self.s.get(self.i)?;
        c.is_ascii_alphabetic().then(|| {
            self.i += 1;
            c
        })
    }
}

// A path's bounding box: its points and its curves' extremes — a cubic's and a quadratic's at their derivative's roots,
// an arc's at its ellipse's axis points within the sweep. None for no path (an error ends the path where it stands).
fn path_bbox(d: &str) -> Option<[f64; 4]> {
    let mut scan = Scanner { s: d.as_bytes(), i: 0 };
    let mut pts: Vec<[f64; 2]> = Vec::new();
    let (mut cur, mut start) = ([0.0, 0.0], [0.0, 0.0]);
    let mut last_ctrl: Option<(u8, [f64; 2])> = None;
    let mut cmd = scan.command()?;
    loop {
        let rel = cmd.is_ascii_lowercase();
        let off = |p: [f64; 2], cur: [f64; 2]| if rel { [p[0] + cur[0], p[1] + cur[1]] } else { p };
        let upper = cmd.to_ascii_uppercase();
        let mut pair = |scan: &mut Scanner<'_>| -> Option<[f64; 2]> { Some([scan.number()?, scan.number()?]) };
        let ok = match upper {
            b'Z' => {
                cur = start;
                last_ctrl = None;
                true
            }
            b'M' | b'L' | b'T' => match pair(&mut scan) {
                Some(p) => {
                    let p = off(p, cur);
                    if upper == b'T' {
                        let c = match last_ctrl {
                            Some((b'Q', c)) => [2.0 * cur[0] - c[0], 2.0 * cur[1] - c[1]],
                            _ => cur,
                        };
                        quad_extremes(&mut pts, cur, c, p);
                        last_ctrl = Some((b'Q', c));
                    } else {
                        last_ctrl = None;
                    }
                    if upper == b'M' {
                        start = p;
                        cmd = if rel { b'l' } else { b'L' };
                    }
                    pts.push(p);
                    cur = p;
                    true
                }
                None => false,
            },
            b'H' | b'V' => match scan.number() {
                Some(v) => {
                    cur = match (upper, rel) {
                        (b'H', true) => [cur[0] + v, cur[1]],
                        (b'H', false) => [v, cur[1]],
                        (_, true) => [cur[0], cur[1] + v],
                        _ => [cur[0], v],
                    };
                    pts.push(cur);
                    last_ctrl = None;
                    true
                }
                None => false,
            },
            b'C' | b'S' => {
                let c1 = if upper == b'C' {
                    pair(&mut scan).map(|p| off(p, cur))
                } else {
                    Some(match last_ctrl {
                        Some((b'C', c)) => [2.0 * cur[0] - c[0], 2.0 * cur[1] - c[1]],
                        _ => cur,
                    })
                };
                match (c1, pair(&mut scan), pair(&mut scan)) {
                    (Some(c1), Some(c2), Some(p)) => {
                        let (c2, p) = (off(c2, cur), off(p, cur));
                        cubic_extremes(&mut pts, cur, c1, c2, p);
                        pts.push(p);
                        last_ctrl = Some((b'C', c2));
                        cur = p;
                        true
                    }
                    _ => false,
                }
            }
            b'Q' => match (pair(&mut scan), pair(&mut scan)) {
                (Some(c), Some(p)) => {
                    let (c, p) = (off(c, cur), off(p, cur));
                    quad_extremes(&mut pts, cur, c, p);
                    pts.push(p);
                    last_ctrl = Some((b'Q', c));
                    cur = p;
                    true
                }
                _ => false,
            },
            b'A' => {
                let args = (scan.number(), scan.number(), scan.number(), scan.flag(), scan.flag(), pair(&mut scan));
                match args {
                    (Some(rx), Some(ry), Some(rot), Some(large), Some(sweep), Some(p)) => {
                        let p = off(p, cur);
                        arc_extremes(&mut pts, cur, rx.abs(), ry.abs(), rot, large, sweep, p);
                        pts.push(p);
                        last_ctrl = None;
                        cur = p;
                        true
                    }
                    _ => false,
                }
            }
            _ => false,
        };
        if !ok {
            break;
        }
        // (…the same command again where numbers follow, or the next)
        let save = scan.i;
        if upper != b'Z' && scan.number().is_some() {
            scan.i = save;
            continue;
        }
        scan.i = save;
        match scan.command() {
            Some(c) => cmd = c,
            None => break,
        }
    }
    union_points(pts.into_iter())
}
fn cubic_extremes(pts: &mut Vec<[f64; 2]>, p0: [f64; 2], p1: [f64; 2], p2: [f64; 2], p3: [f64; 2]) {
    let at = |t: f64, k: usize| {
        let u = 1.0 - t;
        u * u * u * p0[k] + 3.0 * u * u * t * p1[k] + 3.0 * u * t * t * p2[k] + t * t * t * p3[k]
    };
    for k in 0..2 {
        // B'(t)/3 = a t² + b t + c
        let a = -p0[k] + 3.0 * p1[k] - 3.0 * p2[k] + p3[k];
        let b = 2.0 * (p0[k] - 2.0 * p1[k] + p2[k]);
        let c = p1[k] - p0[k];
        let mut roots = Vec::new();
        if a.abs() < 1e-12 {
            if b.abs() > 1e-12 {
                roots.push(-c / b);
            }
        } else {
            let disc = b * b - 4.0 * a * c;
            if disc >= 0.0 {
                let s = disc.sqrt();
                roots.push((-b + s) / (2.0 * a));
                roots.push((-b - s) / (2.0 * a));
            }
        }
        for t in roots.into_iter().filter(|t| *t > 0.0 && *t < 1.0) {
            pts.push([at(t, 0), at(t, 1)]);
        }
    }
}
fn quad_extremes(pts: &mut Vec<[f64; 2]>, p0: [f64; 2], p1: [f64; 2], p2: [f64; 2]) {
    for k in 0..2 {
        let den = p0[k] - 2.0 * p1[k] + p2[k];
        if den.abs() > 1e-12 {
            let t = (p0[k] - p1[k]) / den;
            if t > 0.0 && t < 1.0 {
                let u = 1.0 - t;
                let at = |j: usize| u * u * p0[j] + 2.0 * u * t * p1[j] + t * t * p2[j];
                pts.push([at(0), at(1)]);
            }
        }
    }
}
// (SVG 2 Appendix B.2.4: the endpoint parameterization converted to the center one, the radii scaled up where too small)
#[allow(clippy::too_many_arguments)]
fn arc_extremes(pts: &mut Vec<[f64; 2]>, p0: [f64; 2], mut rx: f64, mut ry: f64, rot: f64, large: bool, sweep: bool, p1: [f64; 2]) {
    if rx == 0.0 || ry == 0.0 || p0 == p1 {
        return;
    }
    let (s, c) = rot.to_radians().sin_cos();
    let (dx, dy) = ((p0[0] - p1[0]) / 2.0, (p0[1] - p1[1]) / 2.0);
    let (x1, y1) = (c * dx + s * dy, -s * dx + c * dy);
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut k = if den == 0.0 { 0.0 } else { (num / den).max(0.0).sqrt() };
    if large == sweep {
        k = -k;
    }
    let (cx1, cy1) = (k * rx * y1 / ry, -k * ry * x1 / rx);
    let (cx, cy) = (c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2.0, s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2.0);
    let angle = |ux: f64, uy: f64| uy.atan2(ux);
    let theta1 = angle((x1 - cx1) / rx, (y1 - cy1) / ry);
    let theta2 = angle((-x1 - cx1) / rx, (-y1 - cy1) / ry);
    let tau = std::f64::consts::TAU;
    let mut delta = (theta2 - theta1).rem_euclid(tau);
    if !sweep && delta > 0.0 {
        delta -= tau;
    }
    let point = |t: f64| {
        let (st, ct) = t.sin_cos();
        [cx + rx * ct * c - ry * st * s, cy + rx * ct * s + ry * st * c]
    };
    // (…each axis's extreme angles: where the point's derivative in that axis is zero)
    let ax = (-ry * s).atan2(rx * c);
    let ay = (ry * c).atan2(rx * s);
    for base in [ax, ay] {
        for k in -2..=2 {
            let t = base + f64::from(k) * std::f64::consts::PI;
            let rel = if delta >= 0.0 { (t - theta1).rem_euclid(tau) } else { (theta1 - t).rem_euclid(tau) };
            if rel > 0.0 && rel < delta.abs() {
                pts.push(point(t));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_boxes() {
        assert_eq!(path_bbox("M0 40 L10 40 L10 48 Z"), Some([0.0, 40.0, 10.0, 48.0]));
        assert_eq!(path_bbox("m1 1h4v2h-4z"), Some([1.0, 1.0, 5.0, 3.0]));
        // (a cubic bulging past its endpoints: extreme y at t = 0.5 is 0.75 · 4)
        let b = path_bbox("M0 0 C0 4 10 4 10 0").unwrap();
        assert!((b[3] - 3.0).abs() < 1e-9, "{b:?}");
        // (a half circle, radius 5, from (0,5) to (10,5) through (5,0) — sweep 1 is clockwise in SVG's y-down space)
        let a = path_bbox("M0 5 A5 5 0 0 1 10 5").unwrap();
        assert!((a[1] - 0.0).abs() < 1e-9 && (a[3] - 5.0).abs() < 1e-9, "{a:?}");
        assert_eq!(numbers("0,0 10 -5e1"), vec![0.0, 0.0, 10.0, -50.0]);
    }

    #[test]
    fn transforms_and_viewboxes() {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.attributes = vec![("transform".into(), "translate(10, 5) scale(2)".into())];
        assert_eq!(apply(&transform_attr(&n), 1.0, 1.0), [12.0, 7.0]);
        n.attributes = vec![("viewBox".into(), "0 0 50 50".into())];
        assert_eq!(apply(&viewbox_map(&n, 100.0, 100.0).0, 5.0, 5.0), [10.0, 10.0]);
        // (meet, centred: a 100x50 viewport over a square viewBox scales by 1 and centres x)
        assert_eq!(apply(&viewbox_map(&n, 100.0, 50.0).0, 0.0, 0.0), [25.0, 0.0]);
    }
}
