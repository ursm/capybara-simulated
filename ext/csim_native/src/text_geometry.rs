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
    // …and the pieces each node's text is in, by index into `rows`: what a range's rects of a node ask for.
    pub(crate) by_node: std::collections::HashMap<NodeId, Vec<usize>>,
    // …and the lines no piece is on (`Blank`).
    blanks: Vec<Blank>,
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
    pub(crate) fn new(arena: &RealmArena, rows: Vec<TextRow>, runs: Vec<Run>, texts: Vec<RunText>, marks: Vec<PaintMark>, inline_nids: &[f64]) -> TextGeometry {
        let mut g = TextGeometry { pass: arena.layout_pass, rows, runs, texts, marks, by_node: std::collections::HashMap::new(), blanks: Vec::new() };
        let mut by_node: std::collections::HashMap<NodeId, Vec<usize>> = std::collections::HashMap::new();
        for (i, r) in g.rows.iter().enumerate() {
            let (start, end) = (r[1] as u32, r[2] as u32);
            let Some(mark) = g.mark(r[0] as usize) else { continue };
            // (…every source the piece overlaps — a piece can run across two nodes' text: `a<b>b</b>`)
            for (k, s) in mark.sources.iter().enumerate() {
                let past = mark.sources.get(k + 1).map_or(u32::MAX, |n| n.offset);
                if s.offset <= end && past >= start {
                    let list = by_node.entry(s.node).or_default();
                    if list.last() != Some(&i) {
                        list.push(i);
                    }
                }
            }
        }
        g.by_node = by_node;
        g.blanks = g.blanks(arena, inline_nids);
        g
    }

    // The empty lines (`Blank`): each `<br>` on a line no piece is on, and each line a preserved newline opens with
    // nothing on it — between two pieces of a run, and, in a form control's value (whose last line is its own even
    // empty), after the last.
    fn blanks(&self, arena: &RealmArena, inline_nids: &[f64]) -> Vec<Blank> {
        let lines: std::collections::HashSet<u64> = self.rows.iter().filter(|r| r[1] != r[2]).map(|r| r[4].to_bits()).collect();
        let mut out = Vec::new();
        for br in inline_nids.iter().filter_map(|&n| NodeId::from_i64(n as i64)) {
            let Some(n) = arena.get(br).filter(|n| n.is_html_named("br")) else { continue };
            let (Some(parent), Some(&[x, y, _, h])) = (n.parent, crate::geometry::laid_frags(arena, n).and_then(|f| f.first())) else { continue };
            if !lines.contains(&y.to_bits()) {
                out.push(Blank { x, top: y, h, place: (parent, arena.child_index(br) as u32), holder: br, owner: parent });
            }
        }
        let mut by_run: std::collections::BTreeMap<usize, Vec<&TextRow>> = std::collections::BTreeMap::new();
        for r in self.rows.iter().filter(|r| r[1] != r[2]) {
            by_run.entry(r[0] as usize).or_default().push(r);
        }
        for (run, rows) in by_run {
            let (Some(mark), Some(info)) = (self.mark(run), self.runs.get(run)) else { continue };
            if !crate::walk::preserving(info.ws_mode) && info.ws_mode != crate::walk::WS_PRE_LINE {
                continue;
            }
            let text = self.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
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
        let geometry = self.text_geometry.borrow();
        let Some(g) = geometry.as_ref().filter(|g| g.pass == self.layout_pass) else { return (hit, 0) };
        // (…an atom that shows no text — an image, a video, a checkbox — the place before it in its parent, wherever over
        // it the point is (Chrome: a replaced box answers its start); a text field's place is in its value, below)
        if let Some(n) = self.get(hit).filter(|n| n.kind == NodeKind::Element && crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name)) {
            if let Some(parent) = n.parent.filter(|_| !g.by_node.contains_key(&hit)) {
                return (parent, self.child_index(hit) as u32);
            }
        }
        // (…each piece where it is in the viewport: its box's scroll shift taken off, as the painter takes it)
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
        for r in g.by_node.get(&node).into_iter().flatten().map(|&i| &g.rows[i]) {
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
    fn reach(&self, g: &TextGeometry, r: &TextRow) -> Reach {
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
    fn place_x(&self, g: &TextGeometry, r: &TextRow, reach: &Reach, at: u32) -> f64 {
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

    // What moves the box a piece starting at the run's offset `start` is in from the document into the viewport…
    fn row_frame(&self, mark: &PaintMark, start: u32) -> Frame {
        match mark.owners.iter().rev().find(|&&(o, _)| o <= start).and_then(|&(_, nid)| NodeId::from_i64(nid as i64)) {
            Some(owner) => self.frame(owner),
            None => Frame { shift: [0.0; 2], chain: None },
        }
    }
    // …that of the box `owner`'s text moves with (`box_owner`): its scroll shift, then its transforms.
    fn frame(&self, owner: NodeId) -> Frame {
        match self.box_owner(owner) {
            Some(o) => Frame { shift: crate::geometry::scroll_shift(self, o), chain: crate::geometry::transform_chain(self, o) },
            None => Frame { shift: [0.0; 2], chain: None },
        }
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
            let [_, line_top, _, line_h] = self.row_frame(mark, r[1] as u32).rect([r[3], r[4], r[6], r[9]]);
            let line_bottom = line_top + line_h;
            let gap = if up { top - line_bottom } else { line_top - bottom };
            if gap >= -0.5 && best.is_none_or(|(d, _)| gap < d) {
                best = Some((gap, (line_top + line_bottom) / 2.0));
            }
        }
        // (…an empty line one too)
        for b in g.blanks.iter().filter(|b| self.holds(root, b.holder)) {
            let [_, line_top, _, line_h] = self.frame(b.owner).rect([b.x, b.top, 0.0, b.h]);
            let gap = if up { top - (line_top + line_h) } else { line_top - bottom };
            if gap >= -0.5 && best.is_none_or(|(d, _)| gap < d) {
                best = Some((gap, line_top + line_h / 2.0));
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
