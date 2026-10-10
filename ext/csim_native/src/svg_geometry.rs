// SVG GEOMETRY (SVG 2 §8, §9, §11): where the graphics inside an outer `<svg>` are — which the layout knows nothing of,
// the `<svg>` being one replaced box to it. An element's user space maps to its outer `<svg>`'s content box through the
// viewports on the way (each `<svg>`'s `viewBox` and `preserveAspectRatio`) and every transform — the `transform`
// property, about its `transform-origin` in its `transform-box`, or else the attribute's list. A shape's geometry is
// its geometry properties' as the style engine computed them (an `x`, a `cx`, an `r`, a `width`, a `d`: the presentation
// attributes, CSS, any unit), a line's and a polyline's their attributes'. Its bounding box is its geometry's — a path's
// to its curves' extremes — and a container's the union of its children's. What reads it: an element's client rect
// (`getBoundingClientRect`), and the hit test, which finds the graphics element under a point inside an `<svg>` — its
// fill where painted, its stroke where painted (`pointer-events: visiblePainted`, and the other values), a nested
// `<svg>` clipping what is under it to its viewport. Not modelled yet: text's geometry, `use`, markers.

use style::properties::ComputedValues;
use style::servo_arc::Arc;
use style::values::computed::Length;
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
fn translation(x: f64, y: f64) -> Affine {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

fn is_svg(n: &NodeData) -> bool {
    n.kind == NodeKind::Element && n.ns == ns!(svg)
}
// The elements whose content is never rendered: their subtrees are templates, resources, metadata.
const NOT_RENDERED: [&str; 12] =
    ["defs", "symbol", "clipPath", "mask", "marker", "pattern", "linearGradient", "radialGradient", "filter", "title", "desc", "metadata"];
// The containers whose children are rendered: a shape's, a text's, an image's are not.
const CONTAINERS: [&str; 4] = ["svg", "g", "a", "switch"];

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

fn style(arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
    crate::style::primary_style(arena, id)
}
fn px(lp: &style::values::computed::LengthPercentage, basis: f64) -> f64 {
    f64::from(lp.resolve(Length::new(basis as f32)).px())
}
// The normalized diagonal a length that is neither horizontal nor vertical (an `r`) is a percentage of.
fn diagonal(vp: [f64; 2]) -> f64 {
    vp[0].hypot(vp[1]) / std::f64::consts::SQRT_2
}

// A length attribute that is no CSS property (a line's `x1`, an inner `<svg>`'s `x` where it is not styled) in user
// units: a number, a CSS length — an `em` and an `ex` by the element's font size, the absolute units by their ratios — or a
// percentage of `basis`; none where absent or no length.
fn attr_length(n: &NodeData, s: Option<&ComputedValues>, name: &str, basis: f64) -> Option<f64> {
    let v = n.plain_attr(name)?.trim();
    let split = v.find(|c: char| c.is_ascii_alphabetic() || c == '%').unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let num: f64 = num.trim().parse().ok().filter(|v: &f64| v.is_finite())?;
    let font = s.map_or(16.0, |s| f64::from(s.get_font().font_size.computed_size().px()));
    let per = match unit.to_ascii_lowercase().as_str() {
        "" | "px" => 1.0,
        "%" => basis / 100.0,
        "em" => font,
        "ex" => font / 2.0,
        "rem" => 16.0,
        "in" => 96.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "q" => 96.0 / 101.6,
        "pt" => 96.0 / 72.0,
        "pc" => 16.0,
        _ => return None,
    };
    Some(num * per)
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
// and meet or slice), the identity where it has none; and the size of that user space.
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
            "translate" => translation(arg(0, 0.0), arg(1, 0.0)),
            "scale" => [arg(0, 1.0), 0.0, 0.0, arg(1, arg(0, 1.0)), 0.0, 0.0],
            "rotate" => {
                let (s, c) = arg(0, 0.0).to_radians().sin_cos();
                let rot = [c, s, -s, c, 0.0, 0.0];
                let (cx, cy) = (arg(1, 0.0), arg(2, 0.0));
                then(&then(&translation(cx, cy), &rot), &translation(-cx, -cy))
            }
            "skewX" => [1.0, 0.0, arg(0, 0.0).to_radians().tan(), 1.0, 0.0, 0.0],
            "skewY" => [1.0, arg(0, 0.0).to_radians().tan(), 0.0, 1.0, 0.0, 0.0],
            _ => return IDENTITY,
        };
        m = then(&m, &step);
    }
    m
}

// An element's own transform in its parent's user space: the `transform` property's functions (with `translate`,
// `rotate` and `scale`) about its `transform-origin` in its `transform-box` — its geometry's box (`fill-box`) or its
// viewport's (`view-box`, the initial: the origin the UA sheet's `0 0`) — else the `transform` attribute's list.
fn element_transform(arena: &RealmArena, id: NodeId, n: &NodeData, s: Option<&ComputedValues>, vp: [f64; 2]) -> Affine {
    let Some(s) = s else { return transform_attr(n) };
    let b = s.get_box();
    let ops = crate::geometry::individual_transforms(b);
    if ops.is_empty() && b.transform.0.is_empty() {
        return transform_attr(n);
    }
    use style::values::computed::TransformBox;
    let reference = match b.transform_box {
        TransformBox::FillBox => local_bbox(arena, id, vp).map_or([0.0; 4], |r| [r[0], r[1], r[2] - r[0], r[3] - r[1]]),
        _ => [0.0, 0.0, vp[0], vp[1]],
    };
    let rect = euclid::default::Rect::new(
        euclid::default::Point2D::origin(),
        euclid::default::Size2D::new(Length::new(reference[2] as f32), Length::new(reference[3] as f32)),
    );
    let mut m = IDENTITY;
    for op in ops.iter().chain(b.transform.0.iter()) {
        use style::values::generics::transform::ToMatrix;
        let Ok(m4) = op.to_3d_matrix(Some(&rect)) else { return IDENTITY };
        let a = m4.to_array();
        m = then(&m, &[a[0], a[1], a[4], a[5], a[12], a[13]]);
    }
    let origin = &b.transform_origin;
    let (ox, oy) = (reference[0] + px(&origin.horizontal, reference[2]), reference[1] + px(&origin.vertical, reference[3]));
    then(&then(&translation(ox, oy), &m), &translation(-ox, -oy))
}

// The outer `<svg>`'s content box in viewport coordinates — its layout box less its borders and padding.
fn content_box(arena: &RealmArena, svg: NodeId) -> Option<[f64; 4]> {
    let [x, y, w, h] = crate::geometry::laid_out_box(arena, svg)?;
    // (…its edges padding, border and margin, each top / right / bottom / left)
    let e = crate::geometry::edges(arena, svg).unwrap_or([0.0; 12]);
    Some([x + e[7] + e[3], y + e[4] + e[0], (w - e[5] - e[7] - e[1] - e[3]).max(0.0), (h - e[4] - e[6] - e[0] - e[2]).max(0.0)])
}
// An inner `<svg>`'s viewport, in its parent's user space: its `x`, `y`, `width` and `height` (the whole parent
// viewport's size where it has none).
fn inner_viewport(n: &NodeData, s: Option<&ComputedValues>, vp: [f64; 2]) -> [f64; 4] {
    let geometry = |prop: Option<f64>, attr: &str, basis: f64, or: f64| prop.or_else(|| attr_length(n, s, attr, basis)).unwrap_or(or);
    let svg = s.map(|s| s.get_svg());
    let pos = s.map(|s| s.get_position());
    let size = |v: Option<&style::values::computed::Size>, basis: f64| match v {
        Some(style::values::generics::length::GenericSize::LengthPercentage(lp)) => Some(px(&lp.0, basis)),
        _ => None,
    };
    [
        geometry(svg.map(|g| px(&g.x, vp[0])).filter(|&v| v != 0.0), "x", vp[0], 0.0),
        geometry(svg.map(|g| px(&g.y, vp[1])).filter(|&v| v != 0.0), "y", vp[1], 0.0),
        geometry(size(pos.map(|p| &p.width), vp[0]), "width", vp[0], vp[0]),
        geometry(size(pos.map(|p| &p.height), vp[1]), "height", vp[1], vp[1]),
    ]
}

// The map from `id`'s user space — its own transform applied — to its outer `<svg>`'s content box, and the size of the
// viewport its lengths' percentages are of; none where an ancestor on the way renders no children (a `<path>` in a
// `<rect>` is none).
fn user_map(arena: &RealmArena, id: NodeId, outer: NodeId) -> Option<(Affine, [f64; 2])> {
    let [_, _, w, h] = content_box(arena, outer)?;
    if id == outer {
        return Some(viewbox_map(arena.get(outer)?, w, h));
    }
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
        let s = style(arena, el);
        m = then(&m, &element_transform(arena, el, n, s.as_deref(), vp));
        if &*n.local_name == "svg" {
            let [x, y, iw, ih] = inner_viewport(n, s.as_deref(), vp);
            let (inner, size) = viewbox_map(n, iw, ih);
            m = then(&then(&m, &translation(x, y)), &inner);
            vp = size;
        }
    }
    Some((m, vp))
}

// A shape's geometry in its user space, as its geometry properties compute.
enum Shape {
    // A rect, an image, a foreignObject: [x, y, w, h].
    Rect([f64; 4]),
    // A circle, an ellipse: centre and radii.
    Ellipse([f64; 4]),
    // A line, a polyline, a polygon, a path: its subpaths, each its points (curves flattened) and whether it is closed;
    // and its exact bounding box.
    Path(Vec<(Vec<[f64; 2]>, bool)>, Option<[f64; 4]>),
}
fn shape(n: &NodeData, s: Option<&ComputedValues>, vp: [f64; 2]) -> Option<Shape> {
    let svg = s.map(|s| s.get_svg());
    let len = |get: &dyn Fn(&style::properties::style_structs::SVG) -> f64, attr: &str, basis: f64| {
        svg.map_or_else(|| attr_length(n, s, attr, basis).unwrap_or(0.0), get)
    };
    let size = |v: Option<&style::values::computed::Size>, attr: &str, basis: f64| match v {
        Some(style::values::generics::length::GenericSize::LengthPercentage(lp)) => px(&lp.0, basis).max(0.0),
        Some(_) => 0.0,
        None => attr_length(n, s, attr, basis).unwrap_or(0.0).max(0.0),
    };
    let pos = s.map(|s| s.get_position());
    let attr = |name: &str, basis: f64| attr_length(n, s, name, basis).unwrap_or(0.0);
    Some(match &*n.local_name {
        "rect" | "image" | "foreignObject" => Shape::Rect([
            len(&|g| px(&g.x, vp[0]), "x", vp[0]),
            len(&|g| px(&g.y, vp[1]), "y", vp[1]),
            size(pos.map(|p| &p.width), "width", vp[0]),
            size(pos.map(|p| &p.height), "height", vp[1]),
        ]),
        "circle" => {
            let r = len(&|g| px(&g.r.0, diagonal(vp)), "r", diagonal(vp)).max(0.0);
            Shape::Ellipse([len(&|g| px(&g.cx, vp[0]), "cx", vp[0]), len(&|g| px(&g.cy, vp[1]), "cy", vp[1]), r, r])
        }
        "ellipse" => {
            use style::values::generics::length::GenericLengthPercentageOrAuto as Auto;
            let radius = |v: Option<&style::values::computed::NonNegativeLengthPercentageOrAuto>, basis: f64| match v {
                Some(Auto::LengthPercentage(lp)) => Some(px(&lp.0, basis).max(0.0)),
                _ => None,
            };
            let (rx, ry) = (radius(svg.map(|g| &g.rx), vp[0]), radius(svg.map(|g| &g.ry), vp[1]));
            let (rx, ry) = (rx.or(ry).unwrap_or(0.0), ry.or(rx).unwrap_or(0.0));
            Shape::Ellipse([len(&|g| px(&g.cx, vp[0]), "cx", vp[0]), len(&|g| px(&g.cy, vp[1]), "cy", vp[1]), rx, ry])
        }
        "line" => {
            let pts = vec![[attr("x1", vp[0]), attr("y1", vp[1])], [attr("x2", vp[0]), attr("y2", vp[1])]];
            let b = union_points(pts.iter().copied());
            Shape::Path(vec![(pts, false)], b)
        }
        "polyline" | "polygon" => {
            let pts: Vec<[f64; 2]> = numbers(n.plain_attr("points").unwrap_or("")).chunks_exact(2).map(|p| [p[0], p[1]]).collect();
            let b = union_points(pts.iter().copied());
            Shape::Path(vec![(pts, &*n.local_name == "polygon")], b)
        }
        "path" => {
            let d = path_data(n, s);
            let segs = segments(&d);
            Shape::Path(flatten(&segs), bbox_of(&segs))
        }
        _ => return None,
    })
}
// A path's data: its `d` property's (a presentation attribute or CSS), else its attribute's.
fn path_data(n: &NodeData, s: Option<&ComputedValues>) -> String {
    if let Some(style::values::specified::svg::DProperty::Path(data)) = s.map(|s| &s.get_svg().d) {
        let mut out = String::new();
        if data.to_css(&mut style_traits::CssWriter::new(&mut out), false).is_ok() {
            return out;
        }
    }
    n.plain_attr("d").unwrap_or("").to_string()
}
fn shape_bbox(shape: &Shape) -> Option<[f64; 4]> {
    match shape {
        Shape::Rect([x, y, w, h]) => Some([*x, *y, x + w, y + h]),
        Shape::Ellipse([cx, cy, rx, ry]) => Some([cx - rx, cy - ry, cx + rx, cy + ry]),
        Shape::Path(_, b) => *b,
    }
}

// The bounding box of `id`'s geometry in its user space, `[x0, y0, x1, y1]` (its own transform not applied): a shape's,
// or a container's — the union of its rendered children's, each under its own transform (an inner `<svg>`'s through
// its viewport). None where it has none.
fn local_bbox(arena: &RealmArena, id: NodeId, vp: [f64; 2]) -> Option<[f64; 4]> {
    let n = arena.get(id).filter(|n| is_svg(n))?;
    let s = style(arena, id);
    if !CONTAINERS.contains(&&*n.local_name) {
        return shape(n, s.as_deref(), vp).and_then(|sh| shape_bbox(&sh));
    }
    let (inner_vp, inner_map) = if &*n.local_name == "svg" {
        let [x, y, w, h] = inner_viewport(n, s.as_deref(), vp);
        let (map, size) = viewbox_map(n, w, h);
        (size, then(&translation(x, y), &map))
    } else {
        (vp, IDENTITY)
    };
    let mut out: Option<[f64; 4]> = None;
    for &c in &n.children {
        let Some(cn) = arena.get(c).filter(|cn| is_svg(cn) && !NOT_RENDERED.contains(&&*cn.local_name)) else { continue };
        let Some(b) = local_bbox(arena, c, inner_vp) else { continue };
        let cs = style(arena, c);
        let m = then(&inner_map, &element_transform(arena, c, cn, cs.as_deref(), inner_vp));
        let corners = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(|[x, y]| apply(&m, x, y));
        let Some(cb) = union_points(corners.into_iter()) else { continue };
        out = Some(match out {
            Some(o) => [o[0].min(cb[0]), o[1].min(cb[1]), o[2].max(cb[2]), o[3].max(cb[3])],
            None => cb,
        });
    }
    out
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
        let m = then(&m, &element_transform(arena, id, n, style(arena, id).as_deref(), vp));
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
// paints on top — rendered (not in a resource, shown, not inert), in its parent `<svg>`s' viewports (an inner one clips
// to its own, `overflow` not visible), and taking the point by its `pointer-events` (`visiblePainted` initially: its fill
// where it has one, its stroke where it has one, visible). None for the `<svg>`'s own background. The map down is carried
// along the walk, each element's transform taken once.
pub(crate) fn hit(arena: &RealmArena, svg: NodeId, x: f64, y: f64) -> Option<NodeId> {
    let [ox, oy, w, h] = content_box(arena, svg)?;
    let (px, py) = match crate::geometry::transform_chain(arena, svg) {
        Some(t) => {
            let inv = crate::geometry::inverse_homography(&t)?;
            let [ux, uy] = crate::geometry::project(&inv, x, y)?;
            (ux - ox, uy - oy)
        }
        None => (x - ox, y - oy),
    };
    let (root_map, root_vp) = viewbox_map(arena.get(svg)?, w, h);
    let mut found = None;
    let mut stack: Vec<(NodeId, Affine, [f64; 2])> = arena.get(svg)?.children.iter().rev().map(|&c| (c, root_map, root_vp)).collect();
    while let Some((id, parent_map, vp)) = stack.pop() {
        let Some(n) = arena.get(id).filter(|n| is_svg(n)) else { continue };
        if NOT_RENDERED.contains(&&*n.local_name) {
            continue;
        }
        let s = style(arena, id);
        if s.as_deref().is_some_and(|s| s.get_box().clone_display().is_none()) {
            continue;
        }
        let m = then(&parent_map, &element_transform(arena, id, n, s.as_deref(), vp));
        if CONTAINERS.contains(&&*n.local_name) {
            let (map, child_vp) = if &*n.local_name == "svg" {
                let [vx, vy, vw, vh] = inner_viewport(n, s.as_deref(), vp);
                let clips = s.as_deref().is_none_or(|s| s.get_box().overflow_x != style::computed_values::overflow_x::T::Visible);
                let inside = invert(&m).map(|inv| apply(&inv, px, py)).is_some_and(|[ux, uy]| ux >= vx && ux <= vx + vw && uy >= vy && uy <= vy + vh);
                if clips && !inside {
                    continue;
                }
                let (inner, size) = viewbox_map(n, vw, vh);
                (then(&then(&m, &translation(vx, vy)), &inner), size)
            } else {
                (m, vp)
            };
            for &c in n.children.iter().rev() {
                stack.push((c, map, child_vp));
            }
            continue;
        }
        let Some(sh) = shape(n, s.as_deref(), vp) else { continue };
        let Some([ux, uy]) = invert(&m).map(|inv| apply(&inv, px, py)) else { continue };
        if takes_point(s.as_deref(), &sh, ux, uy, vp) && !arena.is_inert(id) {
            found = Some(id);
        }
    }
    found
}

// Whether a shape takes the point (ux, uy) of its user space, by its `pointer-events`: its fill area and its stroke
// area, each where it is painted (`visiblePainted`, `painted`), or whatever its paint (`visibleFill`, `fill`, …);
// visible or not as the value asks; none for `none`.
fn takes_point(s: Option<&ComputedValues>, sh: &Shape, ux: f64, uy: f64, vp: [f64; 2]) -> bool {
    use style::computed_values::pointer_events::T as PE;
    use style::values::generics::svg::GenericSVGPaintKind as Paint;
    let Some(s) = s else { return in_fill(sh, ux, uy, true) };
    let visible = s.get_inherited_box().visibility == style::computed_values::visibility::T::Visible;
    let svg = s.get_inherited_svg();
    let fill_painted = !matches!(svg.fill.kind, Paint::None);
    let stroke_painted = !matches!(svg.stroke.kind, Paint::None);
    let (needs_visible, fill, stroke) = match s.get_inherited_ui().pointer_events {
        PE::None => return false,
        PE::Auto | PE::Visiblepainted => (true, fill_painted, stroke_painted),
        PE::Visiblefill => (true, true, false),
        PE::Visiblestroke => (true, false, true),
        PE::Visible => (true, true, true),
        PE::Painted => (false, fill_painted, stroke_painted),
        PE::Fill => (false, true, false),
        PE::Stroke => (false, false, true),
        PE::All => (false, true, true),
    };
    if needs_visible && !visible {
        return false;
    }
    let half = match &svg.stroke_width {
        style::values::generics::svg::GenericSVGLength::LengthPercentage(lp) => px(&lp.0, diagonal(vp)) / 2.0,
        _ => 0.5,
    };
    let nonzero = !matches!(svg.fill_rule, style::values::generics::basic_shape::FillRule::Evenodd);
    (fill && in_fill(sh, ux, uy, nonzero)) || (stroke && half > 0.0 && in_stroke(sh, ux, uy, half))
}
fn in_fill(sh: &Shape, x: f64, y: f64, nonzero: bool) -> bool {
    match sh {
        Shape::Rect([rx, ry, w, h]) => x >= *rx && x <= rx + w && y >= *ry && y <= ry + h,
        Shape::Ellipse([cx, cy, rx, ry]) => *rx > 0.0 && *ry > 0.0 && ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0,
        // (…each subpath closed for its fill, the winding number or its parity — a point on its edge in it, as Chrome has it)
        Shape::Path(subpaths, _) => {
            if in_stroke(sh, x, y, 1e-6) {
                return true;
            }
            let mut winding = 0i32;
            for (pts, _) in subpaths {
                for i in 0..pts.len() {
                    let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                    if a[1] <= y && b[1] > y && cross(a, b, [x, y]) > 0.0 {
                        winding += 1;
                    } else if a[1] > y && b[1] <= y && cross(a, b, [x, y]) < 0.0 {
                        winding -= 1;
                    }
                }
            }
            if nonzero { winding != 0 } else { winding % 2 != 0 }
        }
    }
}
fn cross(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])
}
fn in_stroke(sh: &Shape, x: f64, y: f64, half: f64) -> bool {
    match sh {
        Shape::Rect([rx, ry, w, h]) => {
            let outside = x < rx - half || x > rx + w + half || y < ry - half || y > ry + h + half;
            let inside = x > rx + half && x < rx + w - half && y > ry + half && y < ry + h - half;
            !outside && !inside
        }
        Shape::Ellipse([cx, cy, rx, ry]) => {
            if *rx <= 0.0 || *ry <= 0.0 {
                return false;
            }
            let r = ((x - cx) / rx).hypot((y - cy) / ry);
            (r - 1.0).abs() * rx.min(*ry) <= half
        }
        Shape::Path(subpaths, _) => subpaths.iter().any(|(pts, closed)| {
            let n = pts.len();
            let edges = if *closed { n } else { n.saturating_sub(1) };
            (0..edges).any(|i| distance_to_segment([x, y], pts[i], pts[(i + 1) % n]) <= half)
        }),
    }
}
fn distance_to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0) };
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
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

// A path's segments in absolute coordinates, each from the end of the one before.
#[derive(Clone, Copy)]
enum Seg {
    Move([f64; 2]),
    Line([f64; 2]),
    Cubic([f64; 2], [f64; 2], [f64; 2]),
    Quad([f64; 2], [f64; 2]),
    // An arc's centre parameterization: its centre, radii, x-axis rotation's sine and cosine, start angle and sweep.
    Arc([f64; 2], [f64; 2], [f64; 2], f64, f64, [f64; 2]),
    Close,
}
// The segments of path data, as far as it parses (an error ends the path where it stands).
fn segments(d: &str) -> Vec<Seg> {
    let mut scan = Scanner { s: d.as_bytes(), i: 0 };
    let mut out = Vec::new();
    let (mut cur, mut start) = ([0.0, 0.0], [0.0, 0.0]);
    let mut last_ctrl: Option<(u8, [f64; 2])> = None;
    let Some(mut cmd) = scan.command() else { return out };
    loop {
        let rel = cmd.is_ascii_lowercase();
        let off = |p: [f64; 2], cur: [f64; 2]| if rel { [p[0] + cur[0], p[1] + cur[1]] } else { p };
        let upper = cmd.to_ascii_uppercase();
        let pair = |scan: &mut Scanner<'_>| -> Option<[f64; 2]> { Some([scan.number()?, scan.number()?]) };
        let seg = match upper {
            b'Z' => {
                cur = start;
                Some(Seg::Close)
            }
            b'M' => pair(&mut scan).map(|p| {
                let p = off(p, cur);
                start = p;
                cmd = if rel { b'l' } else { b'L' };
                Seg::Move(p)
            }),
            b'L' => pair(&mut scan).map(|p| Seg::Line(off(p, cur))),
            b'H' => scan.number().map(|v| Seg::Line([if rel { cur[0] + v } else { v }, cur[1]])),
            b'V' => scan.number().map(|v| Seg::Line([cur[0], if rel { cur[1] + v } else { v }])),
            b'C' => match (pair(&mut scan), pair(&mut scan), pair(&mut scan)) {
                (Some(c1), Some(c2), Some(p)) => Some(Seg::Cubic(off(c1, cur), off(c2, cur), off(p, cur))),
                _ => None,
            },
            b'S' => match (pair(&mut scan), pair(&mut scan)) {
                (Some(c2), Some(p)) => {
                    let c1 = match last_ctrl {
                        Some((b'C', c)) => [2.0 * cur[0] - c[0], 2.0 * cur[1] - c[1]],
                        _ => cur,
                    };
                    Some(Seg::Cubic(c1, off(c2, cur), off(p, cur)))
                }
                _ => None,
            },
            b'Q' => match (pair(&mut scan), pair(&mut scan)) {
                (Some(c), Some(p)) => Some(Seg::Quad(off(c, cur), off(p, cur))),
                _ => None,
            },
            b'T' => pair(&mut scan).map(|p| {
                let c = match last_ctrl {
                    Some((b'Q', c)) => [2.0 * cur[0] - c[0], 2.0 * cur[1] - c[1]],
                    _ => cur,
                };
                Seg::Quad(c, off(p, cur))
            }),
            b'A' => {
                let args = (scan.number(), scan.number(), scan.number(), scan.flag(), scan.flag(), pair(&mut scan));
                match args {
                    (Some(rx), Some(ry), Some(rot), Some(large), Some(sweep), Some(p)) => {
                        let p = off(p, cur);
                        Some(arc_center(cur, rx.abs(), ry.abs(), rot, large, sweep, p).unwrap_or(Seg::Line(p)))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(seg) = seg else { break };
        last_ctrl = match seg {
            Seg::Cubic(_, c2, _) => Some((b'C', c2)),
            Seg::Quad(c, _) => Some((b'Q', c)),
            _ => None,
        };
        cur = end_of(&seg).unwrap_or(cur);
        out.push(seg);
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
    out
}
fn end_of(seg: &Seg) -> Option<[f64; 2]> {
    match *seg {
        Seg::Move(p) | Seg::Line(p) | Seg::Cubic(_, _, p) | Seg::Quad(_, p) | Seg::Arc(_, _, _, _, _, p) => Some(p),
        Seg::Close => None,
    }
}
// (SVG 2 Appendix B.2.4: the endpoint parameterization converted to the centre one, the radii scaled up where too
// small; none for a degenerate arc, a line then)
fn arc_center(p0: [f64; 2], mut rx: f64, mut ry: f64, rot: f64, large: bool, sweep: bool, p1: [f64; 2]) -> Option<Seg> {
    if rx == 0.0 || ry == 0.0 || p0 == p1 {
        return None;
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
    let centre = [c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2.0, s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2.0];
    let theta1 = ((y1 - cy1) / ry).atan2((x1 - cx1) / rx);
    let theta2 = ((-y1 - cy1) / ry).atan2((-x1 - cx1) / rx);
    let tau = std::f64::consts::TAU;
    let mut delta = (theta2 - theta1).rem_euclid(tau);
    if !sweep && delta > 0.0 {
        delta -= tau;
    }
    Some(Seg::Arc(centre, [rx, ry], [s, c], theta1, delta, p1))
}
fn arc_point(centre: [f64; 2], r: [f64; 2], [s, c]: [f64; 2], t: f64) -> [f64; 2] {
    let (st, ct) = t.sin_cos();
    [centre[0] + r[0] * ct * c - r[1] * st * s, centre[1] + r[0] * ct * s + r[1] * st * c]
}

// A path's bounding box: its points and its curves' extremes — a cubic's and a quadratic's at their derivative's roots,
// an arc's at its ellipse's axis points within the sweep.
fn bbox_of(segs: &[Seg]) -> Option<[f64; 4]> {
    let mut pts: Vec<[f64; 2]> = Vec::new();
    let mut cur = [0.0, 0.0];
    let mut start = cur;
    for seg in segs {
        match *seg {
            Seg::Move(p) => {
                start = p;
                pts.push(p);
            }
            Seg::Line(p) => pts.push(p),
            Seg::Cubic(c1, c2, p) => {
                cubic_extremes(&mut pts, cur, c1, c2, p);
                pts.push(p);
            }
            Seg::Quad(c, p) => {
                quad_extremes(&mut pts, cur, c, p);
                pts.push(p);
            }
            Seg::Arc(centre, r, sc, theta1, delta, p) => {
                let [s, c] = sc;
                for base in [(-r[1] * s).atan2(r[0] * c), (r[1] * c).atan2(r[0] * s)] {
                    for k in -2..=2 {
                        let t = base + f64::from(k) * std::f64::consts::PI;
                        let tau = std::f64::consts::TAU;
                        let rel = if delta >= 0.0 { (t - theta1).rem_euclid(tau) } else { (theta1 - t).rem_euclid(tau) };
                        if rel > 0.0 && rel < delta.abs() {
                            pts.push(arc_point(centre, r, sc, t));
                        }
                    }
                }
                pts.push(p);
            }
            Seg::Close => {}
        }
        cur = end_of(seg).unwrap_or(start);
    }
    union_points(pts.into_iter())
}
// …and its subpaths as polylines, each curve in 16 steps, an arc in steps of its sweep.
fn flatten(segs: &[Seg]) -> Vec<(Vec<[f64; 2]>, bool)> {
    const STEPS: usize = 16;
    let mut out: Vec<(Vec<[f64; 2]>, bool)> = Vec::new();
    let mut cur = [0.0, 0.0];
    for seg in segs {
        if !matches!(seg, Seg::Move(_) | Seg::Close) && out.last().is_none_or(|(_, closed)| *closed) {
            out.push((vec![cur], false));
        }
        match *seg {
            Seg::Move(p) => out.push((vec![p], false)),
            Seg::Line(p) => out.last_mut().unwrap().0.push(p),
            Seg::Cubic(c1, c2, p) => {
                let p0 = cur;
                let poly = &mut out.last_mut().unwrap().0;
                for i in 1..=STEPS {
                    let t = i as f64 / STEPS as f64;
                    let u = 1.0 - t;
                    let at = |k: usize| u * u * u * p0[k] + 3.0 * u * u * t * c1[k] + 3.0 * u * t * t * c2[k] + t * t * t * p[k];
                    poly.push([at(0), at(1)]);
                }
            }
            Seg::Quad(c, p) => {
                let p0 = cur;
                let poly = &mut out.last_mut().unwrap().0;
                for i in 1..=STEPS {
                    let t = i as f64 / STEPS as f64;
                    let u = 1.0 - t;
                    let at = |k: usize| u * u * p0[k] + 2.0 * u * t * c[k] + t * t * p[k];
                    poly.push([at(0), at(1)]);
                }
            }
            Seg::Arc(centre, r, sc, theta1, delta, p) => {
                let poly = &mut out.last_mut().unwrap().0;
                for i in 1..STEPS {
                    poly.push(arc_point(centre, r, sc, theta1 + delta * i as f64 / STEPS as f64));
                }
                poly.push(p);
            }
            Seg::Close => {
                if let Some(last) = out.last_mut() {
                    last.1 = true;
                    cur = last.0[0];
                }
                continue;
            }
        }
        cur = end_of(seg).unwrap_or(cur);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    fn path_bbox(d: &str) -> Option<[f64; 4]> {
        bbox_of(&segments(d))
    }

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
    fn path_hits() {
        let square = Shape::Path(flatten(&segments("M0 0 H10 V10 H0 Z")), None);
        assert!(in_fill(&square, 5.0, 5.0, true));
        assert!(!in_fill(&square, 15.0, 5.0, true));
        assert!(in_stroke(&square, 10.2, 5.0, 0.5));
        assert!(!in_stroke(&square, 5.0, 5.0, 0.5));
        // (a stroke-only zig-zag: on its line, not in its hull)
        let zig = Shape::Path(flatten(&segments("M4 6h16M4 12h16")), None);
        assert!(in_stroke(&zig, 10.0, 6.4, 1.0));
        assert!(!in_stroke(&zig, 10.0, 9.0, 1.0));
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
        n.attributes = vec![("x".into(), "2em".into())];
        assert_eq!(attr_length(&n, None, "x", 100.0), Some(32.0));
    }
}
