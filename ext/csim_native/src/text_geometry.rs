// Where the text of the last layout that recorded it is (layout.js `recordingPass`): each piece a line placed (`layout::TextRow`), the run it draws from, and what each part of that run's text came from (`walk::Source`) —
// what a caret from a point is read off (CSSOM View's `caretPositionFromPoint`, where a press sets the caret, where
// ArrowUp / ArrowDown go) and a range's rects. The runs, their texts and their marks are the pass the walk keeps
// (`walk::Prior`), read through a `TextView`; the rows are the layout's, kept here.

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::layout::{Run, RunText, TextRow};
use crate::walk::{PaintMark, Prior, Source, CONTROL_VALUE, STRIPPED_CR_FF, STRIPPED_SHY};
use std::collections::HashMap;

pub(crate) struct TextGeometry {
    // The layout it was recorded in (`RealmArena::layout_pass`) and the walk's epoch (`Prior::walked`): another layout
    // has moved the text, another kept pass holds other runs.
    pass: u64,
    walked: u64,
    rows: Vec<TextRow>,
    // …and what is asked of them, made the first time: the runs each node's text is in (what a range's rects of a node
    // ask for), the pieces of each run (a run's pieces are its block's, in line order: one range of `rows`), and the
    // lines no piece is on (`Blank`).
    index: std::cell::OnceCell<Index>,
}
struct Index {
    by_node: HashMap<NodeId, Vec<usize>>,
    by_run: Vec<std::ops::Range<usize>>,
    blanks: Vec<Blank>,
}
// The text geometry with the kept pass's runs — what the queries read.
pub(crate) struct TextView<'a> {
    rows: &'a [TextRow],
    runs: &'a [Run],
    texts: &'a [RunText],
    marks: &'a [PaintMark],
    by_node: &'a HashMap<NodeId, Vec<usize>>,
    by_run: &'a [std::ops::Range<usize>],
    blanks: &'a [Blank],
}
// An EMPTY line — no piece on it — and the place a caret on it is at: one a `<br>` ends, the place before the `<br>` (its
// box an empty fragment there); one a preserved newline makes, the place after it in its text (Chrome). In the document
// (`top`, its left edge `x`, its height `h`), moving with `owner`'s box; `holder` what holds it — the `<br>`, the text.
struct Blank {
    x: f64,
    top: f64,
    h: f64,
    place: (NodeId, u32),
    holder: NodeId,
    owner: NodeId,
}

impl TextGeometry {
    pub(crate) fn new(pass: u64, walked: u64, rows: Vec<TextRow>) -> TextGeometry {
        TextGeometry { pass, walked, rows, index: std::cell::OnceCell::new() }
    }
}

impl TextView<'_> {
    fn mark(&self, run: usize) -> Option<&PaintMark> {
        self.marks.binary_search_by_key(&run, |m| m.run).ok().map(|k| &self.marks[k])
    }
    // The pieces `node`'s text is on, in run and line order.
    fn rows_of(&self, node: NodeId) -> impl Iterator<Item = &TextRow> {
        self.by_node.get(&node).into_iter().flatten().flat_map(|&run| self.rows[self.by_run.get(run).cloned().unwrap_or(0..0)].iter())
    }
}

// The runs each node's text is in, by its marks' sources…
fn by_node(marks: &[PaintMark]) -> HashMap<NodeId, Vec<usize>> {
    let mut out: HashMap<NodeId, Vec<usize>> = HashMap::with_capacity(marks.len());
    for m in marks {
        for s in m.sources.iter() {
            let list = out.entry(s.node).or_default();
            if list.last() != Some(&m.run) {
                list.push(m.run);
            }
        }
    }
    out
}
// …and each run's pieces, a range of `rows`.
fn by_run(rows: &[TextRow], runs: usize) -> Vec<std::ops::Range<usize>> {
    let mut out = vec![0..0; runs];
    for (i, r) in rows.iter().enumerate() {
        let Some(range) = out.get_mut(r[0] as usize) else { continue };
        if range.is_empty() {
            *range = i..i + 1;
        } else {
            range.end = i + 1;
        }
    }
    out
}

// The empty lines (`Blank`): each `<br>` on a line no piece is on, and each line a preserved newline opens with nothing on
// it — between two pieces of a run, and, in a form control's value (whose last line is its own even empty), after the
// last.
fn blanks(arena: &RealmArena, g: &TextView, inline_nids: &[f64]) -> Vec<Blank> {
    let mut out = Vec::new();
    let mut lines: Option<std::collections::HashSet<u64>> = None;
    for br in inline_nids.iter().filter_map(|&n| NodeId::from_i64(n as i64)) {
        let Some(n) = arena.get(br).filter(|n| n.is_html_named("br")) else { continue };
        let (Some(parent), Some(&[x, y, _, h])) = (n.parent, crate::geometry::laid_frags(arena, n).and_then(|f| f.first())) else { continue };
        let lines = lines.get_or_insert_with(|| g.rows.iter().filter(|r| r[1] != r[2]).map(|r| r[4].to_bits()).collect());
        if !lines.contains(&y.to_bits()) {
            out.push(Blank { x, top: y, h, place: (parent, arena.child_index(br) as u32), holder: br, owner: parent });
        }
    }
    for (run, info) in g.runs.iter().enumerate() {
        if !crate::walk::preserving(info.ws_mode) && info.ws_mode != crate::walk::WS_PRE_LINE {
            continue;
        }
        let rows: Vec<&TextRow> = g.rows[g.by_run.get(run).cloned().unwrap_or(0..0)].iter().filter(|r| r[1] != r[2]).collect();
        let Some(mark) = g.mark(run).filter(|_| !rows.is_empty()) else { continue };
        let text = g.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
        let newlines = |from: u32, to: u32| (from..to).filter(|&i| text.get(i as usize) == Some(&0x0A)).collect::<Vec<u32>>();
        let mut blank = |r: &TextRow, at: u32, top: f64| {
            if let (Some(s), Some(owner)) = (source_at(&mark.sources, at), mark.owners.iter().rev().find(|&&(o, _)| o <= at).and_then(|&(_, nid)| NodeId::from_i64(nid as i64))) {
                out.push(Blank { x: r[3] - r[8], top, h: r[9], place: (s.node, arena.source_offset(*s, at - s.offset)), holder: s.node, owner });
            }
        };
        for pair in rows.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            for (j, &nl) in newlines(a[2] as u32, b[1] as u32).iter().enumerate().skip(1) {
                blank(a, nl, a[4] + a[9] * j as f64);
            }
        }
        let last = rows[rows.len() - 1];
        if mark.sources.iter().any(|s| s.flags & CONTROL_VALUE != 0) {
            for (j, &nl) in newlines(last[2] as u32, text.len() as u32).iter().enumerate() {
                blank(last, nl + 1, last[4] + last[9] * (j + 1) as f64);
            }
        }
    }
    out
}

impl RealmArena {
    // Whether the last pass that recorded its text is the current layout (`prior` the pass the walk kept): what a query
    // of the text can be read off without one that does (layout.js `ensureTextGeometry`)…
    pub(crate) fn text_current(&self, prior: Option<&Prior>) -> bool {
        self.text_geometry.borrow().as_ref().is_some_and(|g| g.pass == self.layout_pass && prior.is_some_and(|p| p.walked == g.walked))
    }
    // …and that text geometry, with the runs of the pass the walk kept for it, for `ask` — none where either is another
    // layout's.
    pub(crate) fn with_text<R>(&self, prior: Option<&Prior>, ask: impl FnOnce(&TextView) -> R) -> Option<R> {
        let geometry = self.text_geometry.borrow();
        let g = geometry.as_ref().filter(|g| g.pass == self.layout_pass)?;
        let prior = prior.filter(|p| p.walked == g.walked)?;
        let index = g.index.get_or_init(|| {
            let (by_node, by_run) = (by_node(&prior.paint), by_run(&g.rows, prior.runs.len()));
            let bare = TextView { rows: &g.rows, runs: &prior.runs, texts: &prior.run_texts, marks: &prior.paint, by_node: &by_node, by_run: &by_run, blanks: &[] };
            let blanks = blanks(self, &bare, &prior.inline_nids);
            Index { by_node, by_run, blanks }
        });
        Some(ask(&TextView {
            rows: &g.rows,
            runs: &prior.runs,
            texts: &prior.run_texts,
            marks: &prior.paint,
            by_node: &index.by_node,
            by_run: &index.by_run,
            blanks: &index.blanks
        }))
    }

    // The caret position at the viewport point (`x`, `y`) in `hit`, the element a hit there lands on: of the text pieces
    // in it, the one on the line the point is on — the nearest line, past its lines — and nearest it across, the place
    // between two of its characters nearest the point; `hit` itself at 0 where it holds no text (an image, an `<svg>`
    // shape). As the text node and offset it is in, or the form control and the offset in its value.
    pub(crate) fn caret_from_point(&self, g: &TextView, x: f64, y: f64, hit: NodeId) -> (NodeId, u32) {
        // (…an atom that shows no text — an image, a video, a checkbox — the place before it in its parent, wherever over
        // it the point is (Chrome: a replaced box answers its start); a text field's place is in its value, below)
        if let Some(n) = self.get(hit).filter(|n| n.kind == NodeKind::Element && crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name)) {
            if let Some(parent) = n.parent.filter(|_| !g.by_node.contains_key(&hit)) {
                return (parent, self.child_index(hit) as u32);
            }
        }
        // (…each piece, in the document, against the point taken back through what moves its box there — its scroll
        // shift and its transforms)
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
            let Some([px, py]) = self.row_frame(mark, start).point(x, y) else { continue };
            let (left, top) = (r[3], r[4]);
            let dy = if py < top { top - py } else if py >= top + r[9] { py - (top + r[9]) } else { 0.0 };
            let dx = if px < left { left - px } else if px > left + r[6] { px - (left + r[6]) } else { 0.0 };
            if best.is_none_or(|(d, ..)| (dy, dx) < d) {
                best = Some(((dy, dx), k, [px, py]));
            }
        }
        // (…an empty line in it the place before the `<br>` ending it, or after the newline opening it — where nothing on
        // a line with a piece is nearer)
        let blank = g.blanks.iter().filter(|b| self.holds(hit, b.holder)).filter_map(|b| {
            let [px, py] = self.frame(b.owner).point(x, y)?;
            let dy = if py < b.top { b.top - py } else if py >= b.top + b.h { py - (b.top + b.h) } else { 0.0 };
            Some(((dy, (b.x - px).max(0.0)), b.place))
        }).min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        if let Some((_, place)) = blank.filter(|(d, _)| best.is_none_or(|(near, ..)| *d < near)) {
            return place;
        }
        let Some(((dy, _), k, [x, y])) = best else { return (hit, 0) };
        let (left, top) = (g.rows[k][3], g.rows[k][4]);
        // (…a point above every line the start of the first, below every line the end of the last — Chrome: of the
        // line's first piece or its last)
        if dy > 0.0 {
            let line = g.rows[k][4];
            let above = y < top;
            let held = |r: &TextRow| g.mark(r[0] as usize).and_then(|m| source_at(&m.sources, r[1] as u32)).is_some_and(|s| self.holds(hit, s.node));
            let on_line = g.rows.iter().filter(|r| r[4] == line && r[1] != r[2] && held(r));
            let edge = if above {
                on_line.min_by(|a, b| a[3].total_cmp(&b[3]))
            } else {
                on_line.max_by(|a, b| (a[3] + a[6]).total_cmp(&(b[3] + b[6])))
            };
            let r = edge.unwrap_or(&g.rows[k]);
            return self.run_place(g, r[0] as usize, if above { r[1] } else { r[2] } as u32).unwrap_or((hit, 0));
        }
        // (…the place in the piece's reach — its characters and the white space the line renders beside them — nearest
        // the point: before the first character whose middle is past it)
        let r = &g.rows[k];
        let reach = self.reach(g, r);
        let mut at = reach.from;
        let mut nearest = f64::INFINITY;
        for p in reach.from..=reach.to {
            let d = (left + self.place_x(g, r, &reach, p) - x).abs();
            if d < nearest {
                (at, nearest) = (p, d);
            }
        }
        self.run_place(g, r[0] as usize, at).unwrap_or((hit, 0))
    }

    // The place the run's offset `at` is in its source: a text node and the offset in its data, or a control and the
    // offset in its value.
    fn run_place(&self, g: &TextView, run: usize, at: u32) -> Option<(NodeId, u32)> {
        let s = *source_at(&g.mark(run)?.sources, at)?;
        Some((s.node, self.source_offset(s, at - s.offset)))
    }

    // The rects of `node`'s text from `from` to `to` — offsets in a text node's data, or in a control's value — in the
    // viewport, one a piece of it holds: from where the first place is on the piece to where the last is, its font's
    // content box tall (Chrome); zero wide for a collapsed range of it, the caret's. None for what no piece of the last painted
    // layout holds (white space a line collapsed, text not rendered).
    pub(crate) fn text_rects(&self, g: &TextView, node: NodeId, from: u32, to: u32) -> Vec<[f64; 4]> {
        let mut out = Vec::new();
        for r in g.rows_of(node) {
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
            let reach = self.reach(g, r);
            let (lo, hi) = (a.max(reach.from), b.min(reach.to));
            if lo > hi || (lo == hi && a != b) {
                continue;
            }
            // (…its font's content box on the run's baseline — the line's, less the run's own shift — where its box's
            // scroll shift and transforms put it)
            let (x0, x1) = (self.place_x(g, r, &reach, lo), self.place_x(g, r, &reach, hi));
            let top = r[5] - mark.shift - mark.content[0];
            let rect = self.row_frame(mark, start).rect([r[3] + x0, top, x1 - x0, mark.content[1]]);
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
        // (…a caret on an empty line where no piece holds it: zero wide at its start, the line's height)
        if out.is_empty() && from == to {
            if let Some(b) = g.blanks.iter().find(|b| b.place == (node, from)) {
                out.push(self.frame(b.owner).rect([b.x, b.top, 0.0, b.h]));
            }
        }
        out
    }

    // The run's places a piece holds, in what its line renders around it: its own characters, and the white space either
    // side where the line renders it — after something the line holds before the piece (its pen past the line's start),
    // before something it holds after (short of the line's end, `r[10]`): a collapsible run as one space, the first of
    // its characters (a space's width, whatever it collapsed from — a tab, a newline; none for one that only continues a
    // run collapsed before it), a preserved one whole (Chrome). A caret in it, and a range's rect over it, are there.
    fn reach(&self, g: &TextView, r: &TextRow) -> Reach {
        let (run, start, end) = (r[0] as usize, r[1] as u32, r[2] as u32);
        let text = g.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
        let mode = g.runs.get(run).map_or(0, |ri| ri.ws_mode);
        let preserve = crate::walk::preserving(mode);
        // (…a newline no space but where white space collapses whole: elsewhere the line break it forces)
        let ws = |i: u32| text.get(i as usize).is_some_and(|&u| crate::rendered::is_collapsible_ws(u) && !(u == 0x0A && (preserve || mode == crate::walk::WS_PRE_LINE)));
        let mut reach = Reach { from: start, to: end, before: 0.0, after: 0.0, preserve };
        if r[8] > 0.01 {
            let mut from = start;
            while from > 0 && ws(from - 1) {
                from -= 1;
            }
            if from < start && (preserve || from == 0 || !ws(from - 1)) {
                reach.from = from;
                reach.before = if preserve { self.advance(g, r, from, start) } else { self.space(g, r) };
            }
        }
        if r[8] + self.pen_to(g, r, end) < r[10] - 0.01 {
            let mut to = end;
            while ws(to) {
                to += 1;
            }
            if to > end {
                reach.to = to;
                reach.after = if preserve { self.advance(g, r, end, to) } else { self.space(g, r) };
            }
        }
        reach
    }
    // …and where in the piece a place in that reach is, from its start — in a collapsed run, on its one space's far side
    // but before its first character.
    fn place_x(&self, g: &TextView, r: &TextRow, reach: &Reach, at: u32) -> f64 {
        let (start, end) = (r[1] as u32, r[2] as u32);
        if at < start {
            return -if reach.preserve { self.advance(g, r, at, start) } else if at == reach.from { reach.before } else { 0.0 };
        }
        if at > end {
            let past = self.pen_to(g, r, end);
            return past + if reach.preserve { self.advance(g, r, end, at) } else { reach.after };
        }
        self.pen_to(g, r, at)
    }

    // How far the piece `r` draws from its start to its run's offset `to` — past its end, over the run's text on — at its
    // spacing and from its pen, which a tab's stop is counted from…
    fn pen_to(&self, g: &TextView, r: &TextRow, to: u32) -> f64 {
        self.advance(g, r, r[1] as u32, to)
    }
    // …and how far it moves over the run's text from `from` to `to`, as from the piece's pen.
    fn advance(&self, g: &TextView, r: &TextRow, from: u32, to: u32) -> f64 {
        let run = r[0] as usize;
        let text = g.texts.get(run).and_then(|t| t.as_deref()).and_then(|t| t.get(from as usize..to as usize)).unwrap_or(&[]);
        g.runs.get(run).and_then(|ri| crate::font::with_font(ri.font, |fm| fm.pen_steps(text, ri.size, ri.ls, ri.ws, r[7], r[8], ri.tab_px, ri.tab_min)))
            .map_or(0.0, |steps| steps.chunks(3).map(|c| c[1]).sum())
    }

    // …and how far one space moves it: what a collapsible run of white space renders as.
    fn space(&self, g: &TextView, r: &TextRow) -> f64 {
        g.runs.get(r[0] as usize).and_then(|ri| crate::font::with_font(ri.font, |fm| fm.pen_steps(&[0x20], ri.size, ri.ls, ri.ws, r[7], r[8], ri.tab_px, ri.tab_min)))
            .map_or(0.0, |steps| steps[1])
    }

    // What moves the box a piece starting at the run's offset `start` is in from the document into the viewport…
    fn row_frame(&self, mark: &PaintMark, start: u32) -> Frame {
        match mark.owners.iter().rev().find(|&&(o, _)| o <= start).and_then(|&(_, nid)| NodeId::from_i64(nid as i64)) {
            Some(owner) => self.frame(owner),
            None => Frame { shift: [0.0; 2], chain: None },
        }
    }
    // …that of the box `owner`'s text moves with (`box_owner`): the shift of what that box HOLDS — its own scroll too, a
    // textarea's or a scroller's text being its content — then its transforms.
    fn frame(&self, owner: NodeId) -> Frame {
        match self.box_owner(owner) {
            Some(o) => Frame { shift: crate::geometry::shift_below(self, o), chain: crate::geometry::transform_chain(self, o) },
            None => Frame { shift: [0.0; 2], chain: None },
        }
    }

    // The offset in what the run holds of a source's node of its `offset`: past what the walk took out before it.
    fn source_local(&self, source: Source, offset: u32) -> u32 {
        let Some(n) = self.get(source.node).filter(|n| n.kind == NodeKind::Text && stripping(source.flags)) else { return offset };
        n.data.iter().take(offset as usize).filter(|&&u| !taken(source.flags, u)).count() as u32
    }

    // The middle of the line next above (below, without `up`) the caret on the band `top`..`bottom` among the text `root`
    // holds, in the viewport — the nearest line wholly past the caret's middle, as a caret's box can run past its own line
    // (a 16px font's on a 20px line) — where a caret moving a line from there goes; none past its first (last) line.
    pub(crate) fn line_over(&self, g: &TextView, root: NodeId, top: f64, bottom: f64, up: bool) -> Option<f64> {
        let mid = (top + bottom) / 2.0;
        let mut best: Option<(f64, f64)> = None;
        for r in g.rows {
            if r[1] == r[2] {
                continue;
            }
            let Some(mark) = g.mark(r[0] as usize) else { continue };
            if !source_at(&mark.sources, r[1] as u32).is_some_and(|s| self.holds(root, s.node)) {
                continue;
            }
            let [_, line_top, _, line_h] = self.row_frame(mark, r[1] as u32).rect([r[3], r[4], r[6], r[9]]);
            let line_bottom = line_top + line_h;
            let gap = if up { mid - line_bottom } else { line_top - mid };
            if gap > 0.0 && best.is_none_or(|(d, _)| gap < d) {
                best = Some((gap, (line_top + line_bottom) / 2.0));
            }
        }
        // (…an empty line one too)
        for b in g.blanks.iter().filter(|b| self.holds(root, b.holder)) {
            let [_, line_top, _, line_h] = self.frame(b.owner).rect([b.x, b.top, 0.0, b.h]);
            let gap = if up { mid - (line_top + line_h) } else { line_top - mid };
            if gap > 0.0 && best.is_none_or(|(d, _)| gap < d) {
                best = Some((gap, line_top + line_h / 2.0));
            }
        }
        best.map(|(_, mid)| mid)
    }

    // Home / End: the first (last, with `end`) place of the line the caret on the band `top`..`bottom` is on, among the
    // text `root` holds — its first piece's start; its last piece's end and the white space a wrap leaves hanging after
    // it, the place the next line starts at (Chrome: End on `cccc dddd ` of a wrapped line is past its space, 20) — or an
    // empty line's own place.
    pub(crate) fn line_edge(&self, g: &TextView, root: NodeId, top: f64, bottom: f64, end: bool) -> Option<(NodeId, u32)> {
        let mid = (top + bottom) / 2.0;
        let mut edge: Option<(f64, &TextRow)> = None;
        for r in g.rows {
            if r[1] == r[2] {
                continue;
            }
            let Some(mark) = g.mark(r[0] as usize) else { continue };
            if !source_at(&mark.sources, r[1] as u32).is_some_and(|s| self.holds(root, s.node)) {
                continue;
            }
            let [x, line_top, w, line_h] = self.row_frame(mark, r[1] as u32).rect([r[3], r[4], r[6], r[9]]);
            if mid < line_top || mid >= line_top + line_h {
                continue;
            }
            let at = if end { x + w } else { -x };
            if edge.is_none_or(|(best, _)| at > best) {
                edge = Some((at, r));
            }
        }
        let Some((_, r)) = edge else {
            return g.blanks.iter().filter(|b| self.holds(root, b.holder)).find(|b| {
                let [_, line_top, _, line_h] = self.frame(b.owner).rect([b.x, b.top, 0.0, b.h]);
                mid >= line_top && mid < line_top + line_h
            }).map(|b| b.place);
        };
        let (run, start, mut stop) = (r[0] as usize, r[1] as u32, r[2] as u32);
        if end {
            let text = g.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
            let next = g.rows.iter().any(|o| o[0] == r[0] && o[1] >= r[2] as f64 && o[4] != r[4]);
            // (…a wrap's hanging white space: spaces and tabs up to the next line's first piece, where the run goes on)
            while next && text.get(stop as usize).is_some_and(|&u| u == 0x20 || u == 0x09) {
                stop += 1;
            }
        }
        self.run_place(g, run, if end { stop } else { start })
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

// The places of a run a piece holds (`RealmArena::reach`): from `from` to `to`, the white space `before` and `after` its
// characters as wide as the line renders it.
struct Reach {
    from: u32,
    to: u32,
    before: f64,
    after: f64,
    preserve: bool,
}

// What takes a box from the document into the viewport: its scroll shift, then its transforms (None for none).
struct Frame {
    shift: [f64; 2],
    chain: Option<crate::geometry::M4>,
}
impl Frame {
    // A rect of the document as the viewport sees it — a transformed one as the box its quad occupies.
    fn rect(&self, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
        let shifted = [x - self.shift[0], y - self.shift[1], w, h];
        match &self.chain {
            Some(m) => crate::geometry::transformed_rect(m, shifted),
            None => shifted,
        }
    }
    // …and a point of the viewport where it is in the document: none where a transform flattens the box.
    fn point(&self, x: f64, y: f64) -> Option<[f64; 2]> {
        let [px, py] = match &self.chain {
            Some(m) => crate::geometry::project(&crate::geometry::inverse_homography(m)?, x, y)?,
            None => [x, y],
        };
        Some([px + self.shift[0], py + self.shift[1]])
    }
}

// The source the run's offset `at` is in: the last that starts at or before it.
fn source_at(sources: &[Source], at: u32) -> Option<&Source> {
    sources.iter().rev().find(|s| s.offset <= at)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "caretFromPoint", caret_from_point, context_id);
    crate::dom::register(scope, ns, "textCurrent", text_current, context_id);
    crate::dom::register(scope, ns, "textRects", text_rects, context_id);
    crate::dom::register(scope, ns, "lineOver", line_over, context_id);
    crate::dom::register(scope, ns, "lineEdge", line_edge, context_id);
}

// What a query of the realm's text asks of its arena and its text geometry (`RealmArena::with_text`).
pub(crate) fn with_text<R>(scope: &mut v8::PinScope<'_, '_>, cid: i32, ask: impl FnOnce(&RealmArena, &TextView) -> R) -> Option<R> {
    let d = crate::dom::dom(scope);
    let prior = d.walk_reuse.get(&cid).and_then(|r| r.last());
    let arena = d.arena.enter_known(cid)?;
    arena.with_text(prior, |g| ask(arena, g))
}

// __dom.caretFromPoint(x, y, now, root) -> [[node], offset]: the caret position at the viewport point (`caret_from_point`),
// in the element a hit there lands on — undefined where it lands on none — or, given `root`, in `root`, wherever the point
// is: a line a scroller clipped away is no hit, and a caret moving a line in an editor goes to it all the same.
fn caret_from_point(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let x = args.get(0).number_value(scope).unwrap_or(f64::NAN);
    let y = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let cid = crate::dom::realm_id(scope, &args);
    let within = crate::dom::nid_arg(scope, &args, 3);
    let Some(hit) = within.or_else(|| crate::hit_test::painting(scope, &args, 2, |p| p.hit(x, y, false).first().copied()).flatten()) else { return };
    let (node, offset) = with_text(scope, cid, |arena, g| arena.caret_from_point(g, x, y, hit)).unwrap_or((hit, 0));
    let mut values = vec![crate::dom::nodes_value(scope, cid, &[node])];
    values.push(v8::Integer::new_from_unsigned(scope, offset).into());
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.textCurrent() -> whether the text geometry is the current layout's (`RealmArena::text_current`).
fn text_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let d = crate::dom::dom(scope);
    let prior = d.walk_reuse.get(&cid).and_then(|r| r.last());
    let current = d.arena.enter_known(cid).is_some_and(|arena| arena.text_current(prior));
    rv.set_bool(current);
}

// __dom.textRects(nid, from, to) -> Float64Array [x, y, width, height, …] (`text_rects`).
fn text_rects(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let from = args.get(1).uint32_value(scope).unwrap_or(0);
    let to = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let rects: Vec<f64> = with_text(scope, cid, |arena, g| arena.text_rects(g, node, from, to)).unwrap_or_default().concat();
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
    if let Some(y) = with_text(scope, cid, |arena, g| arena.line_over(g, root, top, bottom, up)).flatten() {
        rv.set_double(y);
    }
}

// __dom.lineEdge(nid, top, bottom, end) -> [[node], offset]: the first or last place of the caret's line in `nid`
// (`line_edge`), or undefined.
fn line_edge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let top = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let bottom = args.get(2).number_value(scope).unwrap_or(f64::NAN);
    let end = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((node, offset)) = with_text(scope, cid, |arena, g| arena.line_edge(g, root, top, bottom, end)).flatten() {
        let values = [crate::dom::nodes_value(scope, cid, &[node]), v8::Integer::new_from_unsigned(scope, offset).into()];
        rv.set(v8::Array::new_with_elements(scope, &values).into());
    }
}
