// Where the text of the last PAINTED layout is (a pass that records its text pieces, layout.js `recordingRuns`): each
// piece a line placed (`layout::TextRow`), the run it draws from, and what each part of that run's text came from
// (`walk::Source`) — what a caret from a point is read off: CSSOM View's `caretPositionFromPoint`, and where a press
// sets the caret.

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::layout::{Run, RunText, TextRow};
use crate::walk::{PaintMark, Source, CONTROL_VALUE, STRIPPED_CR_FF, STRIPPED_SHY};

pub(crate) struct TextGeometry {
    // The layout it was recorded in (`RealmArena::layout_pass`): another has moved the text.
    pub(crate) pass: u64,
    pub(crate) rows: Vec<TextRow>,
    pub(crate) runs: Vec<Run>,
    pub(crate) texts: Vec<RunText>,
    // …the painted runs' marks, in run order.
    pub(crate) marks: Vec<PaintMark>,
}

impl TextGeometry {
    fn mark(&self, run: usize) -> Option<&PaintMark> {
        self.marks.binary_search_by_key(&run, |m| m.run).ok().map(|k| &self.marks[k])
    }
}

impl RealmArena {
    // Whether the text geometry is the current layout's: what a caret from a point can be read off without a pass that
    // records it.
    pub(crate) fn text_geometry_current(&self) -> bool {
        self.text_geometry.borrow().as_ref().is_some_and(|g| g.pass == self.layout_pass)
    }

    // The caret position at the viewport point (`x`, `y`) in `hit`, the element a hit there lands on: of the text pieces
    // in it, the one on the line the point is on — the nearest line, past its lines — and nearest it across, the place
    // between two of its characters nearest the point; `hit` itself at 0 where it holds no text (an image, an `<svg>`
    // shape). As the text node and offset it is in, or the form control and the offset in its value.
    pub(crate) fn caret_from_point(&self, x: f64, y: f64, hit: NodeId) -> (NodeId, u32) {
        // (…an atom — an image, a video, a control — a place beside it in its parent: before it over its left half,
        // after it over its right — Chrome)
        if let Some(n) = self.get(hit).filter(|n| n.kind == NodeKind::Element && crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name)) {
            if let Some(parent) = n.parent {
                let index = self.child_index(hit) as u32;
                let after = crate::geometry::client_rects(self, hit).and_then(|r| r.first().copied()).is_some_and(|[bx, _, bw, _]| x > bx + bw / 2.0);
                return (parent, index + u32::from(after));
            }
        }
        let geometry = self.text_geometry.borrow();
        let Some(g) = geometry.as_ref().filter(|g| g.pass == self.layout_pass) else { return (hit, 0) };
        // (…each piece where it is in the viewport: its box's scroll shift taken off, as the painter takes it)
        let mut best: Option<((f64, f64), usize, [f64; 2])> = None;
        for (k, r) in g.rows.iter().enumerate() {
            let (run, start, end) = (r[0] as usize, r[1] as u32, r[2] as u32);
            if start == end {
                continue;
            }
            let Some(mark) = g.mark(run) else { continue };
            let Some(source) = source_at(&mark.sources, start) else { continue };
            if !self.holds(hit, source.node) {
                continue;
            }
            let shift = self.row_shift(mark, start);
            let (left, top) = (r[3] - shift[0], r[4] - shift[1]);
            let dy = if y < top { top - y } else if y >= top + r[9] { y - (top + r[9]) } else { 0.0 };
            let dx = if x < left { left - x } else if x > left + r[6] { x - (left + r[6]) } else { 0.0 };
            if best.is_none_or(|(d, ..)| (dy, dx) < d) {
                best = Some(((dy, dx), k, [left, top]));
            }
        }
        let Some(((dy, _), k, [left, top])) = best else { return (hit, 0) };
        // (…a point above every line the start of the first, below every line the end of the last — Chrome: of the
        // line's first piece or its last)
        if dy > 0.0 {
            let line = g.rows[k][4];
            let above = y < top;
            let on_line = g.rows.iter().filter(|r| r[4] == line && r[1] != r[2]);
            let edge = if above {
                on_line.min_by(|a, b| a[3].total_cmp(&b[3]))
            } else {
                on_line.max_by(|a, b| (a[3] + a[6]).total_cmp(&(b[3] + b[6])))
            };
            let r = edge.unwrap_or(&g.rows[k]);
            return self.run_place(g, r[0] as usize, if above { r[1] } else { r[2] } as u32).unwrap_or((hit, 0));
        }
        let r = &g.rows[k];
        let (run, start, end) = (r[0] as usize, r[1] as usize, r[2] as usize);
        let piece = g.texts.get(run).and_then(|t| t.as_deref()).and_then(|t| t.get(start..end)).unwrap_or(&[]);
        let into = g.runs.get(run).and_then(|run_info| {
            crate::font::with_font(run_info.font, |fm| fm.pen_steps(piece, run_info.size, run_info.ls, run_info.ws, r[7], r[8], run_info.tab_px, run_info.tab_min))
        });
        // (…the place before the first character whose middle is past the point, in UTF-16 units)
        let mut units = 0;
        if let Some(steps) = into {
            let mut pen = left;
            for (i, cp) in crate::font::code_points(piece).enumerate() {
                let step = steps.get(i * 3 + 1).copied().unwrap_or(0.0);
                if x < pen + step / 2.0 {
                    break;
                }
                pen += step;
                units += if cp > 0xFFFF { 2 } else { 1 };
            }
        } else {
            units = piece.len();
        }
        self.run_place(g, run, (start + units) as u32).unwrap_or((hit, 0))
    }

    // The place the run's offset `at` is in its source: a text node and the offset in its data, or a control and the
    // offset in its value.
    fn run_place(&self, g: &TextGeometry, run: usize, at: u32) -> Option<(NodeId, u32)> {
        let s = *source_at(&g.mark(run)?.sources, at)?;
        Some((s.node, self.source_offset(s, at - s.offset)))
    }

    // The rects of `node`'s text from `from` to `to` — offsets in a text node's data, or in a control's value — in the
    // viewport, one a piece of it holds: from where the first place is on the piece to where the last is, its font's
    // content box tall (Chrome); zero wide for a collapsed range of it, the caret's. None for what no piece of the last painted
    // layout holds (white space a line collapsed, text not rendered).
    pub(crate) fn text_rects(&self, node: NodeId, from: u32, to: u32) -> Vec<[f64; 4]> {
        let geometry = self.text_geometry.borrow();
        let Some(g) = geometry.as_ref().filter(|g| g.pass == self.layout_pass) else { return Vec::new() };
        let mut out = Vec::new();
        for r in &g.rows {
            let (run, start, end) = (r[0] as usize, r[1] as u32, r[2] as u32);
            if start == end {
                continue;
            }
            let Some(mark) = g.mark(run) else { continue };
            // (…the run's offsets of the two places, through the part of the run that node's data is)
            let Some(k) = mark.sources.iter().position(|s| s.node == node) else { continue };
            let s = mark.sources[k];
            let past = mark.sources.get(k + 1).map_or(u32::MAX, |n| n.offset);
            let (a, b) = (s.offset + self.source_local(s, from), (s.offset + self.source_local(s, to)).min(past));
            let (lo, hi) = (a.max(start), b.min(end));
            if lo > hi || (lo == hi && a != b) {
                continue;
            }
            // (…its font's content box on the run's baseline — the line's, less the run's own shift)
            let shift = self.row_shift(mark, start);
            let (mut x0, mut x1) = (self.pen_to(g, r, lo), self.pen_to(g, r, hi));
            // (…and the white space of its part either side of the piece where the line renders it — after something
            // the line holds before the piece (its pen past the line's start), before something it holds after (short
            // of the line's end, `r[10]`): one space of a collapsible run, its first — a space's width whatever it
            // collapsed from, a tab included; a node that only continues one collapsed, none — every one of a
            // preserved run (Chrome))
            if a != b {
                let text = g.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
                let mode = g.runs.get(run).map_or(0, |ri| ri.ws_mode);
                let preserve = crate::walk::preserving(mode);
                // (…a `pre-line` run's newline no space: the line break it forces)
                let ws = |i: u32| text.get(i as usize).is_some_and(|&u| crate::rendered::is_collapsible_ws(u) && !(u == 0x0A && mode == crate::walk::WS_PRE_LINE));
                if lo == start && r[8] > 0.01 {
                    let mut from = start;
                    while from > a && ws(from - 1) {
                        from -= 1;
                    }
                    x0 -= if preserve {
                        self.advance(g, r, from, start)
                    } else if from < start && (from == 0 || !ws(from - 1)) {
                        self.space(g, r)
                    } else {
                        0.0
                    };
                }
                if hi == end && r[8] + self.pen_to(g, r, end) < r[10] - 0.01 {
                    let mut to = end;
                    while to < b && ws(to) {
                        to += 1;
                    }
                    x1 += if preserve { self.advance(g, r, end, to) } else if to > end { self.space(g, r) } else { 0.0 };
                }
            }
            let top = r[5] - mark.shift - mark.content[0];
            let rect = [r[3] - shift[0] + x0, top - shift[1], x1 - x0, mark.content[1]];
            if a == b {
                out.push(rect);
                break;
            }
            // (…the node's pieces on one line one rect, the white space between them in it: Chrome's line fragment)
            match out.last_mut().filter(|last: &&mut [f64; 4]| last[1] == rect[1] && last[3] == rect[3]) {
                Some(last) => {
                    let right = (last[0] + last[2]).max(rect[0] + rect[2]);
                    last[0] = last[0].min(rect[0]);
                    last[2] = right - last[0];
                }
                None => out.push(rect),
            }
        }
        out
    }

    // How far the piece `r` draws from its start to its run's offset `to` — past its end, over the run's text on — at its
    // spacing and from its pen, which a tab's stop is counted from…
    fn pen_to(&self, g: &TextGeometry, r: &TextRow, to: u32) -> f64 {
        self.advance(g, r, r[1] as u32, to)
    }
    // …and how far it moves over the run's text from `from` to `to`, as from the piece's pen.
    fn advance(&self, g: &TextGeometry, r: &TextRow, from: u32, to: u32) -> f64 {
        let run = r[0] as usize;
        let text = g.texts.get(run).and_then(|t| t.as_deref()).and_then(|t| t.get(from as usize..to as usize)).unwrap_or(&[]);
        g.runs.get(run).and_then(|ri| crate::font::with_font(ri.font, |fm| fm.pen_steps(text, ri.size, ri.ls, ri.ws, r[7], r[8], ri.tab_px, ri.tab_min)))
            .map_or(0.0, |steps| steps.chunks(3).map(|c| c[1]).sum())
    }

    // …and how far one space moves it: what a collapsible run of white space renders as.
    fn space(&self, g: &TextGeometry, r: &TextRow) -> f64 {
        g.runs.get(r[0] as usize).and_then(|ri| crate::font::with_font(ri.font, |fm| fm.pen_steps(&[0x20], ri.size, ri.ls, ri.ws, r[7], r[8], ri.tab_px, ri.tab_min)))
            .map_or(0.0, |steps| steps[1])
    }

    // The scroll shift of the box a piece starting at the run's offset `start` moves with, which the viewport sees it by.
    fn row_shift(&self, mark: &PaintMark, start: u32) -> [f64; 2] {
        let owner = mark.owners.iter().rev().find(|&&(o, _)| o <= start).and_then(|&(_, nid)| NodeId::from_i64(nid as i64));
        owner.and_then(|o| self.box_owner(o)).map_or([0.0; 2], |o| crate::geometry::scroll_shift(self, o))
    }

    // The offset in what the run holds of a source's node of its `offset`: past what the walk took out before it.
    fn source_local(&self, source: Source, offset: u32) -> u32 {
        let Some(n) = self.get(source.node).filter(|n| n.kind == NodeKind::Text && stripping(source.flags)) else { return offset };
        n.data.iter().take(offset as usize).filter(|&&u| !taken(source.flags, u)).count() as u32
    }

    // The middle of the line next above (below, without `up`) the band `top`..`bottom` among the text `root` holds, in
    // the viewport — where a caret moving a line from a place on that band goes; none past its first (last) line.
    pub(crate) fn line_over(&self, root: NodeId, top: f64, bottom: f64, up: bool) -> Option<f64> {
        let geometry = self.text_geometry.borrow();
        let g = geometry.as_ref().filter(|g| g.pass == self.layout_pass)?;
        let mut best: Option<(f64, f64)> = None;
        for r in &g.rows {
            if r[1] == r[2] {
                continue;
            }
            let Some(mark) = g.mark(r[0] as usize) else { continue };
            if !source_at(&mark.sources, r[1] as u32).is_some_and(|s| self.holds(root, s.node)) {
                continue;
            }
            let shift = self.row_shift(mark, r[1] as u32);
            let (line_top, line_bottom) = (r[4] - shift[1], r[4] - shift[1] + r[9]);
            let gap = if up { top - line_bottom } else { line_top - bottom };
            if gap >= -0.5 && best.is_none_or(|(d, _)| gap < d) {
                best = Some((gap, (line_top + line_bottom) / 2.0));
            }
        }
        best.map(|(_, mid)| mid)
    }

    // Is `node` in `root`'s flat tree, `root` itself included?
    fn holds(&self, root: NodeId, node: NodeId) -> bool {
        let mut at = Some(node);
        while let Some(n) = at {
            if n == root {
                return true;
            }
            at = crate::geometry::flat_parent(self, n);
        }
        false
    }

    // The element a run of `owner`'s moves with: `owner`, or the nearest flat-tree ancestor with a box (a box-less one's
    // text is laid out in its parent's line — the painter's `runBoxOwner`).
    fn box_owner(&self, owner: NodeId) -> Option<NodeId> {
        let mut at = Some(owner);
        while let Some(n) = at {
            if self.get(n).is_some_and(|d| crate::geometry::laid(self, d).is_some()) {
                return Some(n);
            }
            at = crate::geometry::flat_parent(self, n);
        }
        None
    }

    // The offset in a source's node of the `local`th unit of what the run holds of it: in a text node's data, past what
    // the walk took out of it before then; in a control's value, the same.
    fn source_offset(&self, source: Source, local: u32) -> u32 {
        let Some(n) = self.get(source.node).filter(|n| n.kind == NodeKind::Text && stripping(source.flags)) else { return local };
        let mut kept = 0;
        for (i, &u) in n.data.iter().enumerate() {
            if taken(source.flags, u) {
                continue;
            }
            if kept == local {
                return i as u32;
            }
            kept += 1;
        }
        n.data.len() as u32
    }
}

// Whether the walk took anything out of a source's text node (`walk::Source`)…
fn stripping(flags: u8) -> bool {
    flags & CONTROL_VALUE == 0 && flags & (STRIPPED_CR_FF | STRIPPED_SHY) != 0
}
// …and whether it took the unit `u` out: a preserved CR or FF, or a soft hyphen under `hyphens: none`.
fn taken(flags: u8, u: u16) -> bool {
    (flags & STRIPPED_CR_FF != 0 && (u == 0x0D || u == 0x0C)) || (flags & STRIPPED_SHY != 0 && u == 0xAD)
}

// The source the run's offset `at` is in: the last that starts at or before it.
fn source_at(sources: &[Source], at: u32) -> Option<&Source> {
    sources.iter().rev().find(|s| s.offset <= at)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "caretFromPoint", caret_from_point, context_id);
    crate::dom::register(scope, ns, "textGeometryCurrent", text_geometry_current, context_id);
    crate::dom::register(scope, ns, "textRects", text_rects, context_id);
    crate::dom::register(scope, ns, "lineOver", line_over, context_id);
}

// __dom.caretFromPoint(x, y, now) -> [[node], offset]: the caret position at the viewport point (`caret_from_point`),
// in the element a hit there lands on — undefined where it lands on none.
fn caret_from_point(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let x = args.get(0).number_value(scope).unwrap_or(f64::NAN);
    let y = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let cid = crate::dom::realm_id(scope, &args);
    let Some(hit) = crate::hit_test::painting(scope, &args, 2, |p| p.hit(x, y, false).first().copied()).flatten() else { return };
    let (node, offset) = crate::dom::realm(scope, cid).caret_from_point(x, y, hit);
    let mut values = vec![crate::dom::nodes_value(scope, cid, &[node])];
    values.push(v8::Integer::new_from_unsigned(scope, offset).into());
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.textGeometryCurrent() -> whether the last painted layout's text geometry is the current layout's.
fn text_geometry_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).text_geometry_current());
}

// __dom.textRects(nid, from, to) -> Float64Array [x, y, width, height, …] (`text_rects`).
fn text_rects(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let from = args.get(1).uint32_value(scope).unwrap_or(0);
    let to = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let rects: Vec<f64> = crate::dom::realm(scope, cid).text_rects(node, from, to).concat();
    rv.set(crate::dom::f64_array(scope, &rects).into());
}

// __dom.lineOver(nid, top, bottom, up) -> the middle y of the line next above / below the band (`line_over`), or
// undefined.
fn line_over(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let top = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let bottom = args.get(2).number_value(scope).unwrap_or(f64::NAN);
    let up = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some(y) = crate::dom::realm(scope, cid).line_over(root, top, bottom, up) {
        rv.set_double(y);
    }
}
