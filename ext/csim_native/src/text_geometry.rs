// Where the text of the last layout that recorded it is (layout.js `recordingPass`): each piece a line placed (`layout::TextRow`), the run it draws from, and what each part of that run's text came from (`walk::Source`) —
// what a caret from a point is read off (CSSOM View's `caretPositionFromPoint`, where a press sets the caret, where
// ArrowUp / ArrowDown go) and a range's rects. The runs, their texts and their marks are the pass the walk keeps
// (`walk::Prior`), read through a `TextView`; the rows are the layout's, kept here.

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::layout::{Run, RunText, TextRow, RUN_CLOSE, RUN_OPEN, RUN_TEXT};
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
    // The pieces `node`'s text is on, in run and line order, as indices into `rows`.
    fn pieces_of(&self, node: NodeId) -> impl Iterator<Item = usize> + '_ {
        self.by_node.get(&node).into_iter().flatten().flat_map(|&run| self.by_run.get(run).cloned().unwrap_or(0..0))
    }
    // The pieces on the line the piece `i` is on: from the one no piece of the line comes before to the next such
    // (`TextRow`).
    fn line_of(&self, i: usize) -> std::ops::Range<usize> {
        let (mut lo, mut hi) = (i, i + 1);
        while lo > 0 && self.rows[lo][11] > 0.0 {
            lo -= 1;
        }
        while self.rows.get(hi).is_some_and(|r| r[11] > 0.0) {
            hi += 1;
        }
        lo..hi
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
        for i in g.pieces_of(node) {
            let r = &g.rows[i];
            let (start, end) = (r[1] as u32, r[2] as u32);
            if start == end {
                continue;
            }
            let Some(mark) = g.mark(r[0] as usize) else { continue };
            let (Some(a), Some(b)) = (self.run_offset(mark, node, from), self.run_offset(mark, node, to)) else { continue };
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

    // The run's offset of the place `offset` in `node`, through the part of the run that node's data is — none where the
    // run (`mark`'s) holds none of it.
    fn run_offset(&self, mark: &PaintMark, node: NodeId, offset: u32) -> Option<u32> {
        let k = mark.sources.iter().position(|s| s.node == node)?;
        let s = mark.sources[k];
        let past = mark.sources.get(k + 1).map_or(u32::MAX, |n| n.offset);
        Some((s.offset + self.source_local(s, offset)).min(past))
    }

    // The caret's rect at (`node`, `offset`) in the viewport (`text_rects` of the place) — where the place ends a line a
    // wrap breaks and starts the next, at the end of the first with `upstream` (`line_end_place`: where End leaves it).
    pub(crate) fn caret_rect(&self, g: &TextView, node: NodeId, offset: u32, upstream: bool) -> Option<[f64; 4]> {
        if upstream {
            if let Some((i, x)) = self.caret_piece(g, node, offset, true).and_then(|i| self.line_end(g, i, node, offset).map(|x| (i, x))) {
                let r = &g.rows[i];
                let mark = g.mark(r[0] as usize)?;
                let top = r[5] - mark.shift - mark.content[0];
                return Some(self.row_frame(mark, r[1] as u32).rect([r[3] + self.pen_to(g, r, r[2] as u32) + x, top, 0.0, mark.content[1]]));
            }
        }
        self.text_rects(g, node, offset, offset).first().copied()
    }

    // The piece the caret at (`node`, `offset`) is on: the first whose reach holds the place — the line a wrap breaks at
    // it the next, which it starts — or, with `upstream`, the last piece of the line End leaves it at the end of; the last
    // of a line whose hanging white space holds it, where no piece's reach does.
    fn caret_piece(&self, g: &TextView, node: NodeId, offset: u32, upstream: bool) -> Option<usize> {
        let (mut found, mut hanging) = (None, None);
        for i in g.pieces_of(node) {
            let r = &g.rows[i];
            if r[1] == r[2] {
                continue;
            }
            let Some(at) = g.mark(r[0] as usize).and_then(|m| self.run_offset(m, node, offset)) else { continue };
            // (…a line End leaves the caret at the end of: this piece's, or the one's before it, where End's place is past
            // white space in the next node — `aaaa bbbb<b> cccc</b>`'s, past the bold's space)
            if upstream {
                if let Some(j) = [i.checked_sub(1), Some(i)].into_iter().flatten().find(|&j| self.line_end(g, j, node, offset).is_some()) {
                    return Some(j);
                }
            }
            let reach = self.reach(g, r);
            if found.is_none() && reach.from <= at && at <= reach.to {
                found = Some(i);
            }
            if hanging.is_none() && at > reach.to && g.rows.get(i + 1).is_none_or(|n| n[11] == 0.0) {
                let (run, to, _) = self.line_end_place(g, i);
                if run == r[0] as usize && at <= to {
                    hanging = Some(i);
                }
            }
        }
        found.or(hanging)
    }
    // …how far across from piece `i`'s end its line's end is, where End's place on that line (`line_end_place`) is
    // (`node`, `offset`) — none where it is not…
    fn line_end(&self, g: &TextView, i: usize, node: NodeId, offset: u32) -> Option<f64> {
        if g.rows.get(i + 1).is_some_and(|n| n[11] > 0.0) {
            return None;
        }
        let (run, to, x) = self.line_end_place(g, i);
        (self.run_place(g, run, to) == Some((node, offset))).then_some(x)
    }
    // …and that place on the line whose last piece is `i`: past its characters and the white space after them its line
    // renders, and past what a soft wrap leaves hanging there — a preserved run's spaces, every one (those before a
    // newline or its block's end too: they are on the line); of a collapsible one its first character, in whatever node
    // of the run, or of the next text run, it is (Chrome: End on `cccc dddd ` of a wrapped line is past its space, 20,
    // where the next line starts; on `aaaa bbbb<b> cccc</b>` past the bold's space; on `bbbb   \n   cccc` past only the
    // first) — as a run, its offset, and how far past the piece's end it is across.
    fn line_end_place(&self, g: &TextView, i: usize) -> (usize, u32, f64) {
        let r = &g.rows[i];
        let (run, end) = (r[0] as usize, r[2] as u32);
        let reach = self.reach(g, r);
        let text = g.texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
        // (…none past a `break-spaces` line's own: its spaces wrap, they do not hang)
        if reach.preserve {
            let mut to = reach.to;
            while text.get(to as usize).is_some_and(|&u| u == 0x20 || u == 0x09) {
                to += 1;
            }
            return (run, to, self.advance(g, r, end, to));
        }
        // (…editable text's: a wrapped line of text no one edits ends before its hanging space — Chrome's
        // `lineboundary` in a page's text, 19 where an editor's End is 20)
        let editable = g.mark(run).and_then(|m| source_at(&m.sources, end.saturating_sub(1))).is_some_and(|s| {
            s.flags & CONTROL_VALUE != 0 || self.parent_of(s.node).is_some_and(|p| self.editing_host(p).is_some())
        });
        if r[12] == 0.0 || reach.to > end || !editable {
            return (run, reach.to, reach.after);
        }
        if let Some(&u) = text.get(end as usize) {
            return if crate::rendered::is_collapsible_ws(u) { (run, end + 1, self.space(g, r)) } else { (run, end, 0.0) };
        }
        let next = g.runs.iter().enumerate().skip(run + 1).find(|(_, ri)| ri.kind != RUN_OPEN && ri.kind != RUN_CLOSE);
        match next {
            Some((k, ri)) if ri.kind == RUN_TEXT && g.texts.get(k).and_then(|t| t.as_deref()).and_then(|t| t.first()).is_some_and(|&u| crate::rendered::is_collapsible_ws(u)) => {
                (k, 1, self.space(g, r))
            }
            _ => (run, end, 0.0),
        }
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

    // Home / End: the first (last, with `end`) place of the line the caret at (`node`, `offset`) is on — the line a wrap
    // ends there, with `upstream` (`caret_piece`) — among the text `root` holds: its first piece's start (before a
    // preserved run's leading white space); its last's end and the white space a wrap leaves hanging after it
    // (`line_end_place`); then past the atoms beside it on the line (`past_atoms`), and out of what `root`'s editing does
    // not reach (`editable_place`). An empty line's own place; past the atoms beside a caret on no piece. With whether
    // the place is where a wrap ends the line, the next line's start too: the caret is at the end of this one.
    pub(crate) fn line_edge(&self, g: &TextView, root: NodeId, node: NodeId, offset: u32, upstream: bool, end: bool) -> Option<((NodeId, u32), bool)> {
        if g.blanks.iter().any(|b| b.place == (node, offset)) {
            return Some(((node, offset), false));
        }
        let Some(i) = self.caret_piece(g, node, offset, upstream) else {
            // (…a caret in text no line holds — white space between blocks — on the next text a line does: Chrome takes
            // a place nothing renders to the next one there is)
            let n = self.get(node)?;
            if n.kind == NodeKind::Text {
                // (…the text before it where none follows: white space ending the host)
                let (text, at) = match self.adjacent_text(g, root, node, true) {
                    Some(next) => {
                        let j = g.pieces_of(next).next()?;
                        self.run_place(g, g.rows[j][0] as usize, g.rows[j][1] as u32)?
                    }
                    None => {
                        let j = g.pieces_of(self.adjacent_text(g, root, node, false)?).last()?;
                        self.run_place(g, g.rows[j][0] as usize, g.rows[j][2] as u32)?
                    }
                };
                return self.line_edge(g, root, text, at, false, end);
            }
            // (…a caret between an element's children: on the line of the text either side of it, or past the atoms
            // beside it)
            if n.kind != NodeKind::Element {
                return None;
            }
            let after = n.children.get(offset as usize).map(|&c| (c, 0));
            let before = (offset as usize).checked_sub(1).and_then(|k| n.children.get(k)).map(|&c| (c, self.get(c).map_or(0, |d| d.data.len() as u32)));
            if let Some(text) = [after, before].into_iter().flatten().find(|&(c, at)| self.get(c).is_some_and(|d| d.kind == NodeKind::Text) && self.caret_piece(g, c, at, false).is_some()) {
                return self.line_edge(g, root, text.0, text.1, false, end);
            }
            return Some((self.editable_place(root, self.past_atoms(g, root, (node, offset), end, None, false).0, end), false));
        };
        let held = |&j: &usize| {
            let r = &g.rows[j];
            r[1] != r[2] && g.mark(r[0] as usize).and_then(|m| source_at(&m.sources, r[1] as u32)).is_some_and(|s| self.holds(root, s.node))
        };
        let (rows, line) = (g.rows, g.line_of(i).filter(held));
        let k = if end {
            line.max_by(|&a, &b| (rows[a][3] + rows[a][6]).total_cmp(&(rows[b][3] + rows[b][6])))
        } else {
            line.min_by(|&a, &b| rows[a][3].total_cmp(&rows[b][3]))
        }?;
        let r = &rows[k];
        let place = if end {
            let (run, to, _) = self.line_end_place(g, k);
            self.run_place(g, run, to)?
        } else {
            let reach = self.reach(g, r);
            self.run_place(g, r[0] as usize, if reach.preserve { reach.from } else { r[1] as u32 })?
        };
        let wrapped = end && r[12] != 0.0;
        let (past, hung) = self.past_atoms(g, root, place, end, Some((r[4], r[4] + r[9])), wrapped);
        Some((self.editable_place(root, past, end), wrapped && (past == place || hung)))
    }
    // Whether a soft wrap ends the line the caret at (`node`, `offset`) is on — the next line is of its paragraph, which
    // only a `<br>`, a preserved newline or its block's end ends (`Selection.modify` by a paragraph).
    pub(crate) fn line_wraps(&self, g: &TextView, node: NodeId, offset: u32) -> bool {
        self.caret_piece(g, node, offset, false).is_some_and(|i| g.rows[i][12] != 0.0)
    }
    // The first text after `node` in tree order — before it, without `forward` — in `root`, that a line holds.
    fn adjacent_text(&self, g: &TextView, root: NodeId, node: NodeId, forward: bool) -> Option<NodeId> {
        let mut at = node;
        loop {
            let n = self.get(at)?;
            let inward = if forward { n.children.first() } else { n.children.last() };
            at = match inward {
                Some(&c) if at != node => c,
                _ => loop {
                    if at == root {
                        return None;
                    }
                    let parent = self.parent_of(at)?;
                    let k = self.child_index(at);
                    let sibling = if forward { self.get(parent)?.children.get(k + 1) } else { k.checked_sub(1).and_then(|k| self.get(parent)?.children.get(k)) };
                    match sibling {
                        Some(&s) => break s,
                        None => at = parent,
                    }
                },
            };
            if g.by_node.contains_key(&at) {
                return Some(at);
            }
        }
    }
    // …past the atoms beside the place on its line: the images, controls, `<svg>`s the DOM holds going on (back) from it —
    // across inline elements' edges and text that renders nothing — whose boxes are on the line's band `band` (the first
    // one's, where none is given), and into an inline-block there to its own text's end (start); stopping at text that
    // renders, a `<br>`, a block, or `root`'s edge (Chrome: End on `aaa<img>` is after the image, Home on `<img>aaa`
    // before it, End on `aaa <span style="display:inline-block">X Y</span>` after its `Y`). Past an atom a `wrapped` line
    // ends with, the white space the wrap hangs too, its first character — with whether it went there (Chrome: End on
    // `bbbb <img> cccc` wrapped after the image is past the space before `cccc`).
    fn past_atoms(&self, g: &TextView, root: NodeId, place: (NodeId, u32), end: bool, mut band: Option<(f64, f64)>, wrapped: bool) -> ((NodeId, u32), bool) {
        let Some(n) = self.get(place.0) else { return (place, false) };
        let (mut parent, mut index) = match n.kind {
            NodeKind::Element => (place.0, place.1 as usize),
            // (…from text only where all of it on that side is white space: nothing but a space between it and an atom)
            _ if !(if end { &n.data[(place.1 as usize).min(n.data.len())..] } else { &n.data[..(place.1 as usize).min(n.data.len())] }).iter().all(|&u| crate::rendered::is_collapsible_ws(u)) => {
                return (place, false);
            }
            _ => match n.parent {
                Some(p) => (p, self.child_index(place.0) + usize::from(end)),
                None => return (place, false),
            },
        };
        let (mut out, mut atom) = (place, false);
        loop {
            let Some(p) = self.get(parent) else { break };
            let child = if end { p.children.get(index) } else { index.checked_sub(1).and_then(|k| p.children.get(k)) };
            let Some(&c) = child else {
                // (…out of an inline element's edge)
                match p.parent.filter(|_| parent != root && !crate::rendered::is_block_level(self, parent)) {
                    Some(up) => (index, parent) = (self.child_index(parent) + usize::from(end), up),
                    None => break,
                }
                continue;
            };
            let Some(cn) = self.get(c) else { break };
            let step = if end { index + 1 } else { index - 1 };
            match cn.kind {
                NodeKind::Text if g.by_node.contains_key(&c) => {
                    if wrapped && atom && cn.data.first().is_some_and(|&u| crate::rendered::is_collapsible_ws(u)) {
                        return ((c, 1), true);
                    }
                    break;
                }
                NodeKind::Element if cn.local_name.as_ref() == "br" || crate::rendered::is_block_level(self, c) => break,
                NodeKind::Element if crate::caret::CARET_VOID_TAGS.contains(&&*cn.local_name) || crate::rendered::is_atomic_inline(self, c) => {
                    // (…one not rendered is passed over; one on another line stops it)
                    if let Some(b) = crate::geometry::laid(self, cn) {
                        let (top, bottom) = *band.get_or_insert((b.y, b.y + b.h));
                        if b.y >= bottom || b.y + b.h <= top {
                            break;
                        }
                        // (…past a replaced element or a control; into an inline-block, to its own text's edge — or its box's)
                        let edge = if crate::caret::CARET_VOID_TAGS.contains(&&*cn.local_name) || matches!(cn.local_name.as_ref(), "select" | "textarea") {
                            Some((parent, step as u32))
                        } else {
                            self.inner_edge(g, c, end).or_else(|| self.box_edge(c, end))
                        };
                        let Some(edge) = edge else { break };
                        out = edge;
                        atom = true;
                    }
                    index = step;
                }
                NodeKind::Element => (parent, index) = (c, if end { 0 } else { cn.children.len() }),
                _ => index = step,
            }
        }
        (out, false)
    }
    // …an inline-block's own edge where no text of its own has one: inside it, at its end (start) — an inline-block it
    // ends (starts) with its own — and none where a `<br>` ends it, which the caret stays before (Chrome: SPAN@0 in an
    // empty one, SPAN@1 after its only image).
    fn box_edge(&self, block: NodeId, end: bool) -> Option<(NodeId, u32)> {
        let n = self.get(block)?;
        let kid = if end { n.children.last() } else { n.children.first() };
        match kid.and_then(|&k| self.get(k).map(|d| (k, d))) {
            None => Some((block, 0)),
            Some((_, d)) if d.kind == NodeKind::Element && d.local_name.as_ref() == "br" => None,
            Some((k, d)) if d.kind == NodeKind::Element && crate::rendered::is_atomic_inline(self, k) && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name) => {
                self.box_edge(k, end)
            }
            _ => Some((block, if end { n.children.len() as u32 } else { 0 })),
        }
    }
    // …the last (first, without `end`) place of the text an inline-block's own lines hold — none where they hold none.
    fn inner_edge(&self, g: &TextView, block: NodeId, end: bool) -> Option<(NodeId, u32)> {
        let n = self.get(block)?;
        let kids: Box<dyn Iterator<Item = &NodeId>> = if end { Box::new(n.children.iter().rev()) } else { Box::new(n.children.iter()) };
        for &c in kids {
            if g.by_node.contains_key(&c) {
                let pieces: Vec<usize> = g.pieces_of(c).filter(|&j| g.rows[j][1] != g.rows[j][2]).collect();
                let j = if end { pieces.last() } else { pieces.first() };
                if let Some(&j) = j {
                    let r = &g.rows[j];
                    return self.run_place(g, r[0] as usize, if end { r[2] } else { r[1] } as u32);
                }
            }
            if let Some(place) = self.get(c).filter(|d| d.kind == NodeKind::Element).and_then(|_| self.inner_edge(g, c, end)) {
                return Some(place);
            }
        }
        None
    }
    // …and out of what `root`'s editing does not reach: a place inside an element its editing host's editing stops at
    // (`contenteditable=false`) the place before it — after it, with `end` — in its parent (Chrome: Home on a line a
    // non-editable chip opens is before the chip). Where `root` is not editable, the place.
    fn editable_place(&self, root: NodeId, place: (NodeId, u32), end: bool) -> (NodeId, u32) {
        if self.editing_host(root).is_none() {
            return place;
        }
        let mut out = place;
        let mut at = place.0;
        while at != root {
            let Some(parent) = self.parent_of(at) else { break };
            if self.get(at).is_some_and(|n| n.kind == NodeKind::Element) && self.editing_host(at).is_none() {
                out = (parent, (self.child_index(at) + usize::from(end)) as u32);
            }
            at = parent;
        }
        out
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
    crate::dom::register(scope, ns, "caretRect", caret_rect, context_id);
    crate::dom::register(scope, ns, "lineWraps", line_wraps, context_id);
    crate::dom::register(scope, ns, "caretLineOver", caret_line_over, context_id);
    crate::dom::register(scope, ns, "caretLineEdge", caret_line_edge, context_id);
    crate::dom::register(scope, ns, "caretMoveKeep", caret_move_keep, context_id);
    crate::dom::register(scope, ns, "caretMoveForget", caret_move_forget, context_id);
    crate::dom::register(scope, ns, "charDirection", char_direction, context_id);
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

// __dom.caretRect(nid, offset, upstream, boxed) -> [x, y, width, height]: the caret's rect at the place (`caret_rect`) —
// `boxed`, where the text has none there, the box of the child there or the element (`box_caret_rect`) — or undefined.
fn caret_rect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let upstream = args.get(2).is_true();
    let boxed = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let rect = with_text(scope, cid, |arena, g| {
        arena.caret_rect(g, node, offset, upstream).or_else(|| boxed.then(|| arena.box_caret_rect(node, offset)).flatten())
    });
    if let Some(rect) = rect.flatten() {
        rv.set(crate::dom::f64_array(scope, &rect).into());
    }
}

// __dom.lineWraps(nid, offset) -> whether a soft wrap ends the line the caret at the place is on (`line_wraps`).
fn line_wraps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let wraps = with_text(scope, cid, |arena, g| arena.line_wraps(g, node, offset)).unwrap_or(false);
    rv.set_bool(wraps);
}

// Where the last line-wise move left the caret, and what its place alone does not say: the x a vertical move set out
// from, kept across consecutive ones (Chrome: from `abcd`'s 3rd place to `ef`'s end, then `ghij`'s 3rd), and whether a
// place a wrap ends one line and starts the next is the end of the first — End's (`upstream`; Chrome: End and then Home
// on the wrapped line it was on, not the next). Its caller keeps it once it has set the selection to it
// (`caretMoveKeep`); anything else that sets the selection ends it — another key, a press, a script's (Chrome).
#[derive(Clone, Copy)]
pub(crate) struct CaretMove {
    node: NodeId,
    offset: u32,
    x: Option<f64>,
    upstream: bool,
}

// The realm's kept move, where it is at (`node`, `offset`): the move a line-wise one goes on from.
fn move_from(scope: &mut v8::PinScope<'_, '_>, cid: i32, node: NodeId, offset: u32) -> Option<CaretMove> {
    crate::dom::dom(scope).caret_moves.get(&cid).copied().filter(|m| m.node == node && m.offset == offset)
}

impl RealmArena {
    // A caret's rect at a place between an element's children where the text has none: the child's box there, or the
    // element's at its end, zero wide.
    fn box_caret_rect(&self, node: NodeId, offset: u32) -> Option<[f64; 4]> {
        let n = self.get(node).filter(|n| n.kind == crate::dom::NodeKind::Element)?;
        let child = n.children.get(offset as usize).copied().filter(|&c| self.get(c).is_some_and(|c| c.kind == crate::dom::NodeKind::Element));
        let [x, y, _, h] = *crate::geometry::client_rects(self, child.unwrap_or(node))?.first()?;
        Some([x, y, 0.0, h])
    }
}

// __dom.caretLineOver(root, nid, offset, up, edgeNid, edgeOffset) -> [[node], offset, x]: ArrowUp / ArrowDown — the caret
// a line up or down in `root` (a contenteditable's editing host, or a textarea) from the caret at (`nid`, `offset`): on
// the next line of its text above or below the caret's rect (`line_over`) at the x the moves set out from
// (`caret_from_point`); past the first or last line the edge given. Undefined where the caret has no rect.
fn caret_line_over(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(root), Some(node)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let offset = args.get(2).uint32_value(scope).unwrap_or(0);
    let up = args.get(3).is_true();
    let edge = crate::dom::nid_arg(scope, &args, 4).map(|n| (n, args.get(5).uint32_value(scope).unwrap_or(0)));
    let cid = crate::dom::realm_id(scope, &args);
    let from = move_from(scope, cid, node, offset);
    let at = with_text(scope, cid, |arena, g| {
        let rect = arena.caret_rect(g, node, offset, from.is_some_and(|m| m.upstream)).or_else(|| arena.box_caret_rect(node, offset))?;
        let x = from.and_then(|m| m.x).unwrap_or(rect[0]);
        let at = match arena.line_over(g, root, rect[1], rect[1] + rect[3], up) {
            Some(y) => Some(arena.caret_from_point(g, x, y, root)),
            None => edge,
        };
        Some(at.map(|at| (at, x)))
    })
    .flatten()
    .flatten();
    let Some(((node, offset), x)) = at else { return rv.set_null() };
    let values = [
        crate::dom::nodes_value(scope, cid, &[node]),
        v8::Integer::new_from_unsigned(scope, offset).into(),
        v8::Number::new(scope, x).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.caretLineEdge(root, nid, offset, end) -> [[node], offset, upstream]: Home / End — the first or last place of the
// line in `root` the caret at (`nid`, `offset`) is on (`line_edge`), the line a wrap ends there where the kept move was
// End's; or undefined.
fn caret_line_edge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(root), Some(node)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let offset = args.get(2).uint32_value(scope).unwrap_or(0);
    let end = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let upstream = move_from(scope, cid, node, offset).is_some_and(|m| m.upstream);
    let Some(((node, offset), wrapped)) = with_text(scope, cid, |arena, g| arena.line_edge(g, root, node, offset, upstream, end)).flatten() else {
        return rv.set_null();
    };
    let values = [
        crate::dom::nodes_value(scope, cid, &[node]),
        v8::Integer::new_from_unsigned(scope, offset).into(),
        v8::Boolean::new(scope, wrapped).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.caretMoveKeep(nid, offset, x | undefined, upstream): the move the caller set the selection to is the realm's kept
// one (`CaretMove`)…
fn caret_move_keep(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let x = args.get(2).is_number().then(|| args.get(2).number_value(scope)).flatten();
    let upstream = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::dom(scope).caret_moves.insert(cid, CaretMove { node, offset, x, upstream });
}
// …and `caretMoveForget()`: none any more — something else set the selection.
fn caret_move_forget(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::dom(scope).caret_moves.remove(&cid);
}

// __dom.charDirection(nid, offset) -> 1, 0 or -1: the strong direction of the text at a place in a text node, as
// `Selection.modify()` reads 'left' and 'right' by a character or a word — the code unit after it, else the one before
// it: a right-to-left script's character (Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Adlam) rtl (1), any
// other letter ltr (0); neither, none (-1: its element's `direction` decides).
fn char_direction(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use icu_properties::props::Script;
    let Some(node) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(data) = arena.get(node).filter(|n| n.kind == crate::dom::NodeKind::Text).map(|n| &n.data) else { return rv.set_int32(-1) };
    const RTL: [Script; 8] = [Script::Hebrew, Script::Arabic, Script::Syriac, Script::Thaana, Script::Nko, Script::Samaritan, Script::Mandaic, Script::Adlam];
    let at = [Some(offset), offset.checked_sub(1)];
    for unit in at.into_iter().flatten().filter_map(|i| data.get(i).copied()) {
        let cp = u32::from(unit);
        if crate::unicode::script(cp).is_some_and(|s| RTL.contains(&s)) {
            return rv.set_int32(1);
        }
        if crate::unicode::is_letter(cp) {
            return rv.set_int32(0);
        }
    }
    rv.set_int32(-1);
}
