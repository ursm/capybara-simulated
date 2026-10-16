// Painting the laid-out page — what `save_screenshot` hands back — as a DISPLAY LIST the bindings replay on a 2D
// context (paint.js): the engine decides what is drawn, where, under which clip and matrix, in which colour and font.
//
// There is no second geometry here: the painter reads the SAME boxes every geometry query reads (the boxes the pass left
// in the arena) and the same style every `getComputedStyle` reads, so a screenshot can only ever show what the driver
// already believes. Its one extra input is where each TEXT RUN landed, which a pass that paints keeps (`Painted`, from
// walk_ops.rs `paint_rows`) — the painter cannot re-derive line breaking without repeating the pass — a form control's
// shown text among them, laid out in its box (walk.rs `control_text`).
//
// Paint order is layout's (hit_test.rs `Painting::sort`): the stacking contexts and the CSS 2.1 appendix E phases inside
// each, the SAME comparison `elementFromPoint` makes — so what a screenshot shows on top is what a click lands on, box
// for box. A box's CONTENT — its text, a replaced element's bitmap — is a layer of its own there, painted in the inline
// phase rather than with the box's background. (Hit-testing does not see TEXT: a point over a paragraph's words that
// overlap a float hits the float here and the paragraph in Chrome — it has no line geometry to ask. Opacity groups are
// not modelled.)

use std::collections::HashMap;

use crate::dom::{NodeId, RealmArena};
use crate::style::StyleEngine;

// The text pieces the last pass that paints placed (walk_ops.rs `paint_rows`): `[x, y, baseline, width, justify, owner,
// placeholder, steps at, steps]` a piece — its owner the nid of the element (or generated box) it was written in, -1 for
// none — its text, and the pen steps of a piece drawn a character at a time, `[advance, step, size]` per character.
#[derive(Default)]
pub(crate) struct Painted {
    pub(crate) rows: Vec<f64>,
    pub(crate) texts: Vec<Vec<u16>>,
    pub(crate) steps: Vec<f64>,
}
pub(crate) const ROW: usize = 9;

// The commands a display list is made of, each its code and its operands (paint.js `replay`).
const SAVE: f64 = 0.0;
const RESTORE: f64 = 1.0;
// [a, b, c, d, e, f]: the canvas's matrix set to it.
const MATRIX: f64 = 2.0;
// [x, y, w, h] / [x0, y0, … x3, y3]: the clip narrowed to a rectangle, to a quad.
const CLIP_RECT: f64 = 3.0;
const CLIP_QUAD: f64 = 4.0;
// [colour, x, y, w, h]: a rectangle filled.
const FILL_RECT: f64 = 5.0;
// [node, x, y, w, h]: an element's bitmap drawn into the rectangle — where it has one.
const IMAGE: f64 = 6.0;
// [colour, font, rtl, text, x, y, max width (NaN: none)]: text drawn from its left edge.
const TEXT: f64 = 7.0;

struct List {
    cmds: Vec<f64>,
    strings: Vec<String>,
    string_at: HashMap<String, usize>,
    nodes: Vec<NodeId>,
}
impl List {
    fn string(&mut self, s: &str) -> f64 {
        if let Some(&at) = self.string_at.get(s) {
            return at as f64;
        }
        self.strings.push(s.to_owned());
        self.string_at.insert(s.to_owned(), self.strings.len() - 1);
        (self.strings.len() - 1) as f64
    }
    fn push(&mut self, code: f64, operands: &[f64]) {
        self.cmds.push(code);
        self.cmds.extend_from_slice(operands);
    }
    // The canvas put under `m`, an ABSOLUTE set rather than a multiply so a clip and the box it clips can each be laid
    // down under their own matrix inside one `save()`. The matrix is in VIEWPORT coordinates — the space the boxes are
    // in — so a full-page paint, which shifts the whole picture by the root's scroll, has to shift the matrix's
    // translation with it: the canvas point is `p + D`, the pixel wanted is `M(p) + D`, hence `t + D - A·D`.
    fn matrix(&mut self, m: Option<&[f64; 6]>, dx: f64, dy: f64) {
        match m {
            None => self.push(MATRIX, &[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            Some(m) => self.push(MATRIX, &[m[0], m[1], m[2], m[3], m[4] + dx - (m[0] * dx + m[2] * dy), m[5] + dy - (m[1] * dx + m[3] * dy)]),
        }
    }
}

// JavaScript's `parseFloat`: the longest decimal number at the start of `s` (after its leading whitespace), NaN for none
// — what the computed lengths below were read with, their unit left behind.
fn parse_float(s: &str) -> f64 {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    let mut longest = None;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if s[end..].starts_with("Infinity") {
        return s[..end + 8].parse().unwrap_or(f64::NAN);
    }
    let mut digits = false;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
        digits = true;
        longest = Some(end);
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
            digits = true;
            longest = Some(end);
        }
    }
    if digits && end < bytes.len() && matches!(bytes[end], b'e' | b'E') {
        let mut e = end + 1;
        if matches!(bytes.get(e), Some(b'+' | b'-')) {
            e += 1;
        }
        let start = e;
        while e < bytes.len() && bytes[e].is_ascii_digit() {
            e += 1;
        }
        if e > start {
            longest = Some(e);
        }
    }
    longest.and_then(|n| s[..n].parse().ok()).unwrap_or(f64::NAN)
}
// …and a number written as JavaScript writes it (`${n}`), for the font shorthand.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

// Where a piece's style comes from: the element it was written in — or that element's `::before` / `::after` box — and
// for a control's placeholder the element whose `::placeholder` it is drawn in.
#[derive(Clone, Copy)]
struct Owner {
    // The node whose box it paints with first: the element, or the generated box.
    node: NodeId,
    // …the element, and the pseudo-element its values are read off (`before`, `after`, `placeholder`).
    element: NodeId,
    pseudo: Option<&'static str>,
}

struct Painter<'a> {
    arena: &'a RealmArena,
    engine: &'a mut StyleEngine,
    now: f64,
    dx: f64,
    dy: f64,
    width: f64,
    height: f64,
    list: List,
}

impl Painter<'_> {
    fn value(&mut self, id: NodeId, name: &str, pseudo: Option<&str>) -> Option<String> {
        self.engine.value(self.arena, id, name, pseudo, self.now)
    }
    // A colour the canvas can take, or None for "paint nothing". `transparent` and a zero alpha are the same answer, and
    // both are the common case for a background — most boxes paint none.
    fn paint_color(&mut self, el: NodeId, name: &str) -> Option<String> {
        let raw = self.value(el, name, None)?;
        let v = raw.trim();
        if v.is_empty() || v == "transparent" || v == "none" {
            return None;
        }
        if v.eq_ignore_ascii_case("currentcolor") {
            // (…a keyword the canvas cannot take)
            let color = self.value(el, "color", None)?;
            return opaque(color);
        }
        opaque(v.to_owned())
    }
    // Whether what `el` (or its pseudo-element) draws shows: a `visibility: hidden` or `collapse` box is laid out and draws
    // nothing — its descendants, inheriting it, likewise unless one is `visible` again (CSS 2 §11.2).
    fn visible(&mut self, el: NodeId, pseudo: Option<&str>) -> bool {
        self.value(el, "visibility", pseudo).is_none_or(|v| v == "visible")
    }
    // The COMPUTED `color`, which is what text is painted in.
    fn text_color(&mut self, owner: Owner) -> String {
        self.value(owner.element, "color", owner.pseudo).unwrap_or_else(|| "rgb(0, 0, 0)".to_owned())
    }
    // A font value of the piece's: its element's, or its pseudo-element's.
    fn font_value(&mut self, owner: Owner, name: &str) -> Option<String> {
        self.value(owner.element, name, owner.pseudo)
    }
    // The CSS font shorthand the canvas takes, built from the same computed values layout measured with — so the glyphs
    // drawn are the glyphs that were measured. (A page that names no family gets the browser's STANDARD font, a serif in
    // every major browser.)
    fn font(&mut self, owner: Owner) -> String {
        let size = self.font_value(owner, "font-size").map_or(f64::NAN, |v| parse_float(&v));
        let size = if size.is_nan() || size == 0.0 { 16.0 } else { size };
        let weight = self.font_value(owner, "font-weight").map_or(400.0, |v| parse_float(&v).trunc());
        let style = self.font_value(owner, "font-style").unwrap_or_else(|| "normal".to_owned());
        let family = self.font_value(owner, "font-family").filter(|f| !f.is_empty()).unwrap_or_else(|| "Times New Roman".to_owned());
        let style = if style == "normal" { String::new() } else { format!("{style} ") };
        format!("{style}{} {}px {family}", js_number(weight), js_number(size))
    }
    // A border side's width: 0 for none — whatever its colour, which decides only whether it shows.
    fn border_width(&mut self, el: NodeId, side: &str) -> f64 {
        let style = self.value(el, &format!("border-{side}-style"), None).unwrap_or_else(|| "none".to_owned());
        let style = style.trim().to_ascii_lowercase();
        if style == "none" || style == "hidden" {
            return 0.0;
        }
        let width = self.value(el, &format!("border-{side}-width"), None).map_or(f64::NAN, |v| parse_float(&v));
        if width > 0.0 { width } else { 0.0 }
    }
    // …and the side as it paints: its width and colour, None where it paints none.
    fn border(&mut self, el: NodeId, side: &str) -> Option<(f64, String)> {
        let width = self.border_width(el, side);
        if width == 0.0 {
            return None;
        }
        // (…a transparent one paints nothing; one with no colour of its own the text's)
        let color = match self.value(el, &format!("border-{side}-color"), None) {
            Some(_) => self.paint_color(el, &format!("border-{side}-color"))?,
            None => self.value(el, "color", None).unwrap_or_else(|| "rgb(0, 0, 0)".to_owned()),
        };
        Some((width, color))
    }
    // The border box's own borders and padding, which is what separates it from the content box: [top, right, bottom,
    // left].
    fn content_inset(&mut self, el: NodeId) -> [f64; 4] {
        let mut out = [0.0; 4];
        for (k, side) in SIDES.iter().enumerate() {
            let border = self.border_width(el, side);
            let pad = self.value(el, &format!("padding-{side}"), None).map_or(f64::NAN, |v| parse_float(&v));
            out[k] = border + if pad.is_nan() { 0.0 } else { pad };
        }
        out
    }

    // An element's ancestor clips laid down, `draw` run, and the context put back. A screenshot is not a hot path, so
    // the clip chain is walked per box rather than tracked as a stack — which also means the painter cannot get out of
    // step with a subtree it skipped. Each clip goes down under ITS OWN clipper's matrix, and only then is the canvas set
    // to the matrix the element itself draws under: a rotated clipper clips to its true quad rather than to its bounding
    // box. `content`: what is drawn is the element's CONTENT, which its own overflow clips too.
    fn clipped(&mut self, el: NodeId, m: Option<[f64; 6]>, content: bool, draw: impl FnOnce(&mut Self)) {
        let boxes = crate::geometry::clip_boxes(self.arena, el, content);
        // …and the element's own PROJECTED QUAD where its map is one a canvas cannot draw: the affine the painter falls
        // back to carries three of the four corners and puts the fourth at `p1 + p2 - p0`, a parallelogram where the
        // truth is a trapezoid. Clipping to the real quad keeps the ink inside the shape.
        let quad = crate::geometry::paint_quad(self.arena, el);
        if boxes.is_empty() && m.is_none() && quad.is_none() {
            draw(self);
            return;
        }
        let (dx, dy) = (self.dx, self.dy);
        self.list.push(SAVE, &[]);
        for b in &boxes {
            let bm: [f64; 6] = [b[4], b[5], b[6], b[7], b[8], b[9]];
            let identity = bm == [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
            self.list.matrix((!identity).then_some(&bm), dx, dy);
            self.list.push(CLIP_RECT, &[b[0] + dx, b[1] + dy, b[2], b[3]]);
        }
        if let Some(q) = quad {
            // (…already in viewport coordinates)
            self.list.matrix(None, dx, dy);
            self.list.push(CLIP_QUAD, &[q[0] + dx, q[1] + dy, q[2] + dx, q[3] + dy, q[4] + dx, q[5] + dy, q[6] + dx, q[7] + dy]);
        }
        self.list.matrix(m.as_ref(), dx, dy);
        draw(self);
        self.list.push(RESTORE, &[]);
    }

    // Where a box paints in the frame: its rectangle as layout placed it, and the transform the canvas draws it under —
    // or None for a box that paints nothing here. The box is drawn UNDER the element's transform, so the box, its
    // borders and its bitmap all move together and a rotation comes out as the quad it is.
    fn box_frame(&self, el: NodeId) -> Option<([f64; 4], Option<[f64; 6]>)> {
        let r = crate::rendered::has_own_box(self.arena, el).then(|| crate::geometry::laid_out_box(self.arena, el)).flatten()?;
        if r[2] <= 0.0 || r[3] <= 0.0 {
            return None;
        }
        let m = match crate::geometry::paint_transform(self.arena, el) {
            None => None,
            // (…a transform the painter cannot express at all)
            Some(None) => return None,
            Some(Some(m)) if singular(&m) => return None,
            Some(Some(m)) => Some(m),
        };
        // …and the off-frame test asks about the box the transform PUTS there: a `translate` can bring a box on screen
        // from far outside it, and can carry one off.
        let bounds = match &m {
            Some(m) => transformed_bounds(m, r, self.dx, self.dy),
            None => [r[0] + self.dx, r[1] + self.dy, r[2], r[3]],
        };
        (!self.off_frame(bounds)).then_some((r, m))
    }
    fn off_frame(&self, b: [f64; 4]) -> bool {
        b[0] > self.width || b[1] > self.height || b[0] + b[2] < 0.0 || b[1] + b[3] < 0.0
    }

    // One box: its background and its borders — four rectangles, which is what a solid border IS. (A dashed or dotted
    // one is painted solid for now, and a radius is not honoured.)
    fn paint_box(&mut self, el: NodeId) {
        if !self.visible(el, None) {
            return;
        }
        let Some((r, m)) = self.box_frame(el) else { return };
        let (x, y) = (r[0] + self.dx, r[1] + self.dy);
        self.clipped(el, m, false, |p| {
            if let Some(bg) = p.paint_color(el, "background-color") {
                let c = p.list.string(&bg);
                p.list.push(FILL_RECT, &[c, x, y, r[2], r[3]]);
            }
            for side in SIDES {
                let Some((w, color)) = p.border(el, side) else { continue };
                let c = p.list.string(&color);
                let rect = match side {
                    "top" => [x, y, r[2], w],
                    "bottom" => [x, y + r[3] - w, r[2], w],
                    "left" => [x, y, w, r[3]],
                    _ => [x + r[2] - w, y, w, r[3]],
                };
                p.list.push(FILL_RECT, &[c, rect[0], rect[1], rect[2], rect[3]]);
            }
        });
    }

    // A replaced element's bitmap, which fills its CONTENT box — the border box less its own borders and padding, where
    // layout sized it to sit. The bindings hold the bitmap (an image's decoded one, a canvas's backing store), so the
    // command names the element and draws nothing where it has none.
    fn paint_bitmap(&mut self, el: NodeId) {
        if !self.visible(el, None) {
            return;
        }
        let Some((r, m)) = self.box_frame(el) else { return };
        let (x, y) = (r[0] + self.dx, r[1] + self.dy);
        self.clipped(el, m, true, |p| {
            let [top, right, bottom, left] = p.content_inset(el);
            let (cw, ch) = (r[2] - left - right, r[3] - top - bottom);
            if cw > 0.0 && ch > 0.0 {
                p.list.nodes.push(el);
                let node = (p.list.nodes.len() - 1) as f64;
                p.list.push(IMAGE, &[node, x + left, y + top, cw, ch]);
            }
        });
    }

    // One text piece of `box_owner`'s, in its owner's font and colour, where the flow put it.
    fn paint_run(&mut self, painted: &Painted, row: usize, owner: Owner, box_owner: NodeId) {
        if !self.visible(owner.element, owner.pseudo) {
            return;
        }
        let at = row * ROW;
        let r = &painted.rows[at..at + ROW];
        if crate::geometry::laid_out_box(self.arena, box_owner).is_none() {
            return;
        }
        // The piece was recorded in DOCUMENT coordinates by the flow; the box's shift is the same a rect read applies,
        // so one subtraction puts it in the frame with it — inner scrollers and sticky included.
        let [sx, sy] = crate::geometry::scroll_shift(self.arena, box_owner);
        let (px, baseline) = (r[0] - sx, r[2] - sy);
        let (x, y) = (px + self.dx, baseline + self.dy);
        let m = match crate::geometry::paint_transform(self.arena, box_owner) {
            None => None,
            Some(None) => return,
            Some(Some(m)) if singular(&m) => return,
            Some(Some(m)) => Some(m),
        };
        // Culled on the band the piece can ink — its advance, and the ascent/descent slack the untransformed test spends
        // either side of the baseline — put where the transform puts it: one `translate` on a wrapper must not un-cull
        // the whole document.
        let width = r[3];
        let culled = match &m {
            Some(m) => self.off_frame(transformed_bounds(m, [px, baseline - 40.0, if width != 0.0 { width } else { 1.0 }, 80.0], self.dx, self.dy)),
            None => x > self.width || y < -40.0 || y > self.height + 40.0,
        };
        if culled {
            return;
        }
        let units = &painted.texts[row];
        let text = String::from_utf16_lossy(units);
        let steps = (r[8] > 0.0).then(|| &painted.steps[r[7] as usize..r[7] as usize + 3 * r[8] as usize]);
        self.clipped(box_owner, m, true, |p| {
            let color = p.text_color(owner);
            let color = p.list.string(&color);
            let font = p.font(owner);
            let font = p.list.string(&font);
            // The piece's text in visual order on its paragraph's base direction (its element's, or — `unicode-bidi:
            // plaintext` — its own first strong character's), drawn from its left edge whichever that is.
            let rtl = match p.value(owner.element, "unicode-bidi", owner.pseudo).as_deref() {
                Some("plaintext") => crate::unicode::paragraph_direction(units),
                _ => None,
            }
            .unwrap_or_else(|| p.value(owner.element, "direction", owner.pseudo).as_deref() == Some("rtl"));
            let rtl = f64::from(u8::from(rtl));
            // A piece the flow placed a character at a time — spaced, justified, tabbed, or split across faces — is
            // drawn the same way, each glyph at the pen step native measured it by, so it lands where the box says it
            // does.
            if let Some(steps) = steps {
                let mut pen = x;
                for (k, ch) in text.chars().enumerate() {
                    let (adv, step) = (steps.get(3 * k).copied().unwrap_or(0.0), steps.get(3 * k + 1).copied().unwrap_or(0.0));
                    if adv > 0.0 && !matches!(ch, ' ' | '\u{a0}' | '\t') {
                        let glyph = p.list.string(ch.encode_utf8(&mut [0; 4]));
                        p.list.push(TEXT, &[color, font, rtl, glyph, pen, y, adv]);
                    }
                    pen += step;
                }
                return;
            }
            // Condensed to the advance the FLOW reserved: the layout's figure is the one every geometry query reports, so
            // it wins where the canvas shapes the piece a little differently (it kerns; the flow sums advances).
            let text = p.list.string(&text);
            p.list.push(TEXT, &[color, font, rtl, text, x, y, if width > 0.0 { width } else { f64::NAN }]);
        });
    }

    // The element a piece is written in, as the painter reads its style; None for a piece of no element.
    fn owner(&self, painted: &Painted, row: usize) -> Option<Owner> {
        let r = &painted.rows[row * ROW..row * ROW + ROW];
        let node = NodeId::from_i64(r[5] as i64).filter(|_| r[5] >= 0.0)?;
        let n = self.arena.get(node)?;
        let (element, pseudo) = match n.generated_of {
            Some((origin, which)) => (origin, Some(if which == 1 { "after" } else { "before" })),
            None => (node, None),
        };
        // (…a control's placeholder drawn in its `::placeholder`)
        if r[6] == 1.0 {
            return Some(Owner { node: element, element, pseudo: Some("placeholder") });
        }
        Some(Owner { node, element, pseudo })
    }
    // The box a piece paints WITH: the box of the element it was written in, or the nearest ancestor's that has one. Its
    // owner may generate no box of its own — a `<slot>`, any `display: contents` box, a placeholder — whose text the
    // flow places in its parent's line, and the piece then moves, clips and transforms with the nearest ancestor that
    // does; the owner still answers for the font and the colour.
    fn box_owner(&self, owner: Owner) -> Option<NodeId> {
        let mut at = Some(owner.node);
        while let Some(id) = at {
            if !self.arena.is_element(id) && self.arena.get(id).is_none_or(|n| n.generated_of.is_none()) {
                return None;
            }
            if crate::geometry::laid_out_box(self.arena, id).is_some() {
                return Some(id);
            }
            at = crate::geometry::flat_parent(self.arena, id);
        }
        None
    }
}

const SIDES: [&str; 4] = ["top", "right", "bottom", "left"];

// A colour that is no zero alpha.
fn opaque(v: String) -> Option<String> {
    let lower = v.to_ascii_lowercase();
    let zero_alpha = lower.starts_with("rgba(") && lower.ends_with(')') && {
        let parts: Vec<&str> = lower[5..lower.len() - 1].split(',').map(str::trim).collect();
        parts.len() == 4 && parts[3].parse::<f64>().is_ok_and(|a| a == 0.0) && parts[3].chars().all(|c| c == '0' || c == '.')
    };
    (!zero_alpha).then_some(v)
}
// A SINGULAR matrix collapses the box onto a line — a `rotateX(90deg)` seen edge-on — and a box with no area paints
// nothing. The canvas would still ink the degenerate rect as a hairline.
fn singular(m: &[f64; 6]) -> bool {
    m[0] * m[3] - m[1] * m[2] == 0.0
}
// The axis-aligned bounds a transformed box lands in — only to decide whether it is worth drawing. In VIEWPORT
// coordinates, with the paint's own shift added AFTER the matrix: mapping `p + D` instead of `M(p) + D` is off by
// `(A - I)·D`, zero for a translation and not for a scale.
fn transformed_bounds(m: &[f64; 6], r: [f64; 4], dx: f64, dy: f64) -> [f64; 4] {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (px, py) in [(r[0], r[1]), (r[0] + r[2], r[1]), (r[0], r[1] + r[3]), (r[0] + r[2], r[1] + r[3])] {
        let tx = m[0] * px + m[2] * py + m[4];
        let ty = m[1] * px + m[3] * py + m[5];
        min_x = min_x.min(tx);
        max_x = max_x.max(tx);
        min_y = min_y.min(ty);
        max_y = max_y.max(ty);
    }
    [min_x + dx, min_y + dy, max_x - min_x, max_y - min_y]
}

// Whether `id`'s content includes a bitmap the bindings may hold: an `<img>`, an SVG `<image>`, an `<input type=image>`,
// a `<canvas>`.
fn bitmap_element(arena: &RealmArena, id: NodeId) -> bool {
    let Some(n) = arena.get(id) else { return false };
    n.is_html_named("img")
        || n.is_html_named("canvas")
        || (n.is_html_named("input") && n.input_type() == "image")
        || (n.ns == web_atoms::ns!(svg) && &*n.local_name == "image")
}

// The display list of a page whose root element is `root` (none: a document without one) and body `body`: the frame
// `width` x `height`, shifted by (`dx`, `dy`) — a full-page paint undoes the root's own scroll.
fn display_list(arena: &RealmArena, engine: &mut StyleEngine, painted: &Painted, root: Option<NodeId>, body: Option<NodeId>, frame: [f64; 4], now: f64) -> List {
    let [width, height, dx, dy] = frame;
    let list = List { cmds: Vec::new(), strings: Vec::new(), string_at: HashMap::new(), nodes: Vec::new() };
    let mut p = Painter { arena, engine, now, dx, dy, width, height, list };
    // A page with no background of its own is white, as a browser's canvas is.
    let background = root
        .and_then(|r| p.paint_color(r, "background-color"))
        .or_else(|| body.and_then(|b| p.paint_color(b, "background-color")))
        .unwrap_or_else(|| "#ffffff".to_owned());
    let c = p.list.string(&background);
    p.list.push(FILL_RECT, &[c, 0.0, 0.0, width, height]);

    // The layers, in the order they paint: every laid-out box, and the CONTENT each box owns — its text pieces, and a
    // replaced element's bitmap.
    struct Content {
        rows: Vec<(usize, Owner)>,
        bitmap: bool,
    }
    let mut layers: Vec<(NodeId, bool)> = Vec::new();
    let mut contents: HashMap<NodeId, Content> = HashMap::new();
    fn content<'c>(layers: &mut Vec<(NodeId, bool)>, contents: &'c mut HashMap<NodeId, Content>, el: NodeId) -> &'c mut Content {
        contents.entry(el).or_insert_with(|| {
            layers.push((el, true));
            Content { rows: Vec::new(), bitmap: false }
        })
    }
    for row in 0..painted.texts.len() {
        // (…a piece of nothing but white space draws nothing — JavaScript's `\S`, which the BOM is no match for)
        if !painted.texts[row].iter().any(|&u| !char::from_u32(u32::from(u)).is_some_and(|c| c.is_whitespace() || c == '\u{feff}')) {
            continue;
        }
        let Some(owner) = p.owner(painted, row) else { continue };
        if let Some(box_owner) = p.box_owner(owner) {
            content(&mut layers, &mut contents, box_owner).rows.push((row, owner));
        }
    }
    if let Some(root) = root {
        // (…in tree order, a shadow tree before its host's children; the root's background filled the canvas)
        let mut stack = vec![root];
        while let Some(n) = stack.pop() {
            if n != root && crate::geometry::laid_out_box(arena, n).is_some() {
                layers.push((n, false));
                if bitmap_element(arena, n) {
                    content(&mut layers, &mut contents, n).bitmap = true;
                }
            }
            let node = arena.get(n);
            let shadow = node.and_then(|n| n.shadow_root).map(|sr| arena.element_children(sr)).unwrap_or_default();
            let children = arena.element_children(n);
            stack.extend(children.into_iter().rev());
            stack.extend(shadow.into_iter().rev());
        }
    }
    let order = crate::hit_test::Painting::new(arena, Some(&*p.engine)).sort(&layers);
    for i in order {
        let (el, is_content) = layers[i];
        if !is_content {
            p.paint_box(el);
            continue;
        }
        let Some(c) = contents.get(&el) else { continue };
        if c.bitmap {
            p.paint_bitmap(el);
        }
        for &(row, owner) in &c.rows {
            p.paint_run(painted, row, owner, el);
        }
    }
    p.list
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "paintList", paint_list, context_id);
    crate::dom::register(scope, ns, "paintRuns", paint_runs, context_id);
}

// __dom.paintList(root, body, width, height, dx, dy) -> [commands, strings, nodes]: the display list of the page
// whose root element is `root` (-1 for none), with the text the last pass that paints placed, which it takes
// (`display_list`) — its commands a Float64Array, the strings and the nodes they name by index.
fn paint_list(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::style_op(scope, cid, |scope| paint_list_unguarded(scope, &args, rv));
}
fn paint_list_unguarded(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, args);
    let root = crate::dom::nid_arg(scope, args, 0);
    let body = crate::dom::nid_arg(scope, args, 1);
    let number = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).number_value(scope).unwrap_or(0.0);
    let frame = [number(scope, 2), number(scope, 3), number(scope, 4), number(scope, 5)];
    let now = crate::dom::realm_clock(scope, args);
    let d = crate::dom::dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
    // (…what the paint's own recording pass placed, taken: none where it laid nothing out)
    let painted = arena.painted.take().unwrap_or_default();
    let list = display_list(arena, engine, &painted, root, body, frame, now);
    let cmds: v8::Local<v8::Value> = crate::dom::f64_array(scope, &list.cmds).into();
    let strings: Vec<v8::Local<v8::Value>> =
        list.strings.iter().map(|s| v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
    let strings: v8::Local<v8::Value> = v8::Array::new_with_elements(scope, &strings).into();
    let nodes: Vec<v8::Local<v8::Value>> = list.nodes.iter().map(|&n| crate::dom::node_value(scope, Some(n))).collect();
    let nodes: v8::Local<v8::Value> = v8::Array::new_with_elements(scope, &nodes).into();
    rv.set(v8::Array::new_with_elements(scope, &[cmds, strings, nodes]).into());
}

// __dom.paintRuns() -> [rows, texts]: the text pieces the last pass that paints placed (`Painted`), taken — for the specs
// that ask WHERE a piece was told to go, the pixels only saying that ink landed somewhere.
fn paint_runs(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(arena) = crate::dom::dom(scope).arena.enter_known(cid) else { return };
    let painted = arena.painted.take().unwrap_or_default();
    let rows: v8::Local<v8::Value> = crate::dom::f64_array(scope, &painted.rows).into();
    let texts: Vec<v8::Local<v8::Value>> = painted
        .texts
        .iter()
        .map(|t| v8::String::new_from_two_byte(scope, t, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into))
        .collect();
    let texts: v8::Local<v8::Value> = v8::Array::new_with_elements(scope, &texts).into();
    rv.set(v8::Array::new_with_elements(scope, &[rows, texts]).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_and_write_as_javascript_does() {
        assert_eq!(parse_float("13.5px"), 13.5);
        assert_eq!(parse_float(" -2e1px"), -20.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert!(parse_float("px").is_nan());
        assert_eq!(js_number(16.0), "16");
        assert_eq!(js_number(13.333), "13.333");
        assert!(opaque("rgba(0, 0, 0, 0)".to_owned()).is_none());
        assert!(opaque("rgba(0, 0, 0, 0.5)".to_owned()).is_some());
    }
}
