// Native layout — the reader-flip endgame: the layout PASS runs in Rust over the arena, so the
// crossing is paid ONCE per pass (not per element/run — the per-call granularity that made native
// measureRun a wash). JS cascade computes each element's used values and BATCH-pushes them as a flat
// record buffer (one crossing in); native lays the tree out and writes a border-box per node (one
// crossing out, read back by getBoundingClientRect / offset* / scroll*). Mirrors layout.js's model
// exactly: `el._lb` is a BORDER-BOX in DOCUMENT coordinates, sub-pixel (no rounding — the read
// boundary rounds the integer CSSOM properties). See the layout↔geometry interface mapping.
//
// STAGE L1 = block flow (width/height/min/max, box-sizing, margins/padding/borders, %-resolution, auto
// width=fill, auto height=stacked children, full margin collapsing). STAGE L2 = pure-text blocks (an
// inline formatting context): greedy line breaking with in-process font metrics (mod font / skrifa),
// height = line count × the JS-resolved line-height. NOT YET: floats, inline elements / mixed
// block+text, flex/grid/table (L3), abspos, native cascade (L4). A subtree using an unmodelled feature
// is declined as a WHOLE (the pass returns Unsupported → JS lays it out), never mixed per-node. This
// module is pure (no V8) so the block algorithm is unit-tested here; text-block parity is validated by
// the JS shadow harness against the live layout.

// Sentinels in the input record: a used value that is `auto` / `none` arrives as f64::NAN (JS writes
// NaN for auto width/height/margin and for absent min/max), distinguished from a real 0.
fn is_auto(v: f64) -> bool {
    v.is_nan()
}

// Display codes JS writes into the buffer. `display:none` nodes are NOT pushed (no box). A block whose
// children are all block-level is DISPLAY_BLOCK; one whose content is pure text in a single font (an
// inline formatting context — stage L2) is DISPLAY_TEXT_BLOCK; anything else (inline elements,
// flex/grid/table, mixed block+text, …) is DISPLAY_UNSUPPORTED and the whole subtree falls back to JS.
pub(crate) const DISPLAY_BLOCK: u8 = 1;
pub(crate) const DISPLAY_TEXT_BLOCK: u8 = 2;
pub(crate) const DISPLAY_UNSUPPORTED: u8 = 255;

// One element's used values for block layout, decoded from the flat buffer. Lengths are px; auto/none
// are NaN. Border-box vs content-box is `border_box`. Percentages were ALREADY resolved JS-side against
// the containing block where the used value needed it (matching resolveLayoutProp); what remains
// auto here is genuine `auto` the layout algorithm resolves (width fill / height sum).
#[derive(Clone, Copy)]
pub(crate) struct Input {
    pub(crate) nid: f64, // the arena NodeId (packed) to write the box back to
    pub(crate) parent: i32, // index of the parent record in the buffer, -1 for the pass root
    pub(crate) display: u8,
    pub(crate) border_box: bool,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) min_w: f64,
    pub(crate) max_w: f64,
    pub(crate) min_h: f64,
    pub(crate) max_h: f64,
    pub(crate) mt: f64,
    pub(crate) mr: f64,
    pub(crate) mb: f64,
    pub(crate) ml: f64,
    pub(crate) pt: f64,
    pub(crate) pr: f64,
    pub(crate) pb: f64,
    pub(crate) pl: f64,
    pub(crate) bt: f64,
    pub(crate) br: f64,
    pub(crate) bb: f64,
    pub(crate) bl: f64,
    // Text-block (DISPLAY_TEXT_BLOCK) fields. Its inline content is a RUN SEQUENCE (each run its own
    // font/size/spacing/line-height) in the `runs` buffer at [run_start, run_start+run_count); a run's
    // text is in `run_texts` at the run's index. `strut_lh` is the block's own resolved line-height —
    // the line-box STRUT, which each line's height grows from (max with the runs on it). Unused for a
    // plain block (run_count 0).
    pub(crate) run_start: i32,
    pub(crate) run_count: i32,
    pub(crate) strut_lh: f64,
}

// One inline run: a maximal same-font piece of a text block's content. Text is in `run_texts` at the
// run's index. Widths come from `fm.measure_run` (bit-parity with JS measureRun); `line_height` grows
// the line box.
#[derive(Clone, Copy)]
pub(crate) struct Run {
    pub(crate) font: i32,
    pub(crate) size: f64,
    pub(crate) ls: f64,
    pub(crate) ws: f64,
    pub(crate) line_height: f64,
}

impl Input {
    // Sum of the horizontal / vertical non-content edges (padding + border), used to convert between
    // content-box and border-box widths/heights.
    fn edges_x(&self) -> f64 {
        self.pl + self.pr + self.bl + self.br
    }
    fn edges_y(&self) -> f64 {
        self.pt + self.pb + self.bt + self.bb
    }
    // A used margin, `auto` counted as 0 for block flow's vertical stacking (horizontal auto margins
    // centre, handled in width resolution). L1 does not centre yet — auto → 0.
    fn m(v: f64) -> f64 {
        if is_auto(v) { 0.0 } else { v }
    }
}

// The border-box a pass writes per node, in document coordinates — the native `el._lb`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Box {
    pub(crate) nid: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    pub(crate) auto_height: bool,
}

// Clamp a resolved main size by min/max (min wins over max, per CSS). `none` (NaN) bounds are skipped.
fn clamp_min_max(v: f64, min: f64, max: f64) -> f64 {
    let mut r = v;
    if !is_auto(max) && r > max {
        r = max;
    }
    if !is_auto(min) && r < min {
        r = min;
    }
    r
}

// The outcome of a native pass: laid-out boxes (one per in-flow block node, document coords), or
// Unsupported when the subtree uses a feature L1 doesn't model — the caller then falls back to JS for
// the WHOLE pass (never a per-node mix).
pub(crate) enum Outcome {
    LaidOut(Vec<Box>),
    Unsupported,
}

// Lay out `inputs` (a flat buffer, parent-indexed, the root at index 0) starting from the root's
// border-box origin + width the caller fixes (from the viewport / initial containing block). Returns a
// box per node in input order. Block flow: each block fills its containing block's content width (auto)
// or takes its declared width; in-flow block children stack vertically at the content origin; auto
// height is the children's stacked height (plus this box's own vertical edges).
pub(crate) fn layout_block(inputs: &[Input], runs: &[Run], run_texts: &[Option<Vec<u16>>], root_x: f64, root_y: f64, root_cb_w: f64) -> Outcome {
    if inputs.is_empty() {
        return Outcome::LaidOut(Vec::new());
    }
    // Reject up front if any node uses an unmodelled display — a subtree is laid out natively only when
    // every participant is a block-flow box or a text block. This is the whole-subtree gate.
    for n in inputs {
        if n.display == DISPLAY_UNSUPPORTED {
            return Outcome::Unsupported;
        }
    }
    // Precompute each node's in-flow child boxes (input indices), in document order. A text block has no
    // child records (its text is in `texts`); a block-container's children are block-level boxes.
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); inputs.len()];
    for (i, n) in inputs.iter().enumerate() {
        if n.parent >= 0 {
            let p = n.parent as usize;
            if p < inputs.len() && (n.display == DISPLAY_BLOCK || n.display == DISPLAY_TEXT_BLOCK) {
                children[p].push(i);
            }
        }
    }
    let mut boxes: Vec<Box> = inputs
        .iter()
        .map(|n| Box { nid: n.nid, x: 0.0, y: 0.0, w: 0.0, h: 0.0, auto_height: false })
        .collect();
    // Two phases: MEASURE lays the subtree out relative to each node's own border-box origin (so
    // collapse-through margins can propagate UP through returns without knowing final positions), then
    // PLACE walks once top-down adding absolute offsets. `failed` is set when a text block can't be
    // measured natively (bad font handle, or a tab / combining mark / CJK the L2 line breaker declines)
    // — the whole pass then falls back to JS.
    let root_w = resolve_width(&inputs[0], root_cb_w);
    let failed = std::cell::Cell::new(false);
    measure(0, root_w, inputs, runs, run_texts, &children, &mut boxes, &failed);
    if failed.get() {
        return Outcome::Unsupported;
    }
    place(0, root_x, root_y, &children, &mut boxes);
    Outcome::LaidOut(boxes)
}

// Measure a word (a run of code points) in a run's font (px). None on a bad handle or a tab / combining
// mark measure_run declines.
fn measure_word(run: &Run, word: &[u16]) -> Option<f64> {
    crate::font::with_font(run.font, |fm| fm.measure_run(word, run.size, run.ls, run.ws)).flatten()
}

fn is_ws_u16(u: u16) -> bool {
    matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C)
}

// Greedy line layout for a text block's RUN SEQUENCE (`runs` / `run_texts` parallel, this block's
// slice): tokenize each run's text into words (maximal non-`[ \t\n\r\f]+` runs — NBSP is NOT a break),
// each measured in its OWN run's font; a collapsible space (the first ws at a boundary, that run's
// spaceW) is the break opportunity. Pack greedily against `content_w` comparing `lineX + spaceW + wordW`.
// Line height = `strut_lh` (the block's line-height) grown to the max line-height of the runs on the
// line. Returns (line count, total content height = Σ line heights). None when the text needs a
// construct not modelled — a tab / combining mark (measure_run None), a wide/CJK char (its own break
// unit), or a WORD spanning two runs (no space at the boundary) — so the caller declines to JS.
fn line_layout(runs: &[Run], run_texts: &[Option<Vec<u16>>], strut_lh: f64, content_w: f64) -> Option<(u32, f64)> {
    struct W {
        width: f64,
        lh: f64,
        space_w: f64, // the collapsed space before this word (0 for the first word on the run stream)
        space_before: bool,
    }
    let mut words: Vec<W> = Vec::new();
    let mut pending: Option<f64> = None; // collapsed space width waiting before the next word

    for (ri, run) in runs.iter().enumerate() {
        let text = run_texts.get(ri).and_then(|t| t.as_ref())?;
        if text.iter().any(|&u| is_wide_unit(u)) {
            return None; // CJK/wide breaks between chars — not modelled here
        }
        let space_w = measure_word(run, &[0x20])?;
        let mut i = 0;
        while i < text.len() {
            if is_ws_u16(text[i]) {
                while i < text.len() && is_ws_u16(text[i]) {
                    i += 1;
                }
                // A space is a break opportunity — unless it's leading whitespace at the very start
                // (dropped). Collapse consecutive/boundary spaces to the FIRST one seen.
                if (!words.is_empty() || pending.is_some()) && pending.is_none() {
                    pending = Some(space_w);
                }
            } else {
                let start = i;
                while i < text.len() && !is_ws_u16(text[i]) {
                    i += 1;
                }
                let width = measure_word(run, &text[start..i])?;
                let (space_before, sw) = match pending.take() {
                    Some(s) => (true, s),
                    None => (false, 0.0),
                };
                if !words.is_empty() && !space_before {
                    return None; // a word spans two runs with no space between (mixed-font word)
                }
                words.push(W { width, lh: run.line_height, space_w: sw, space_before });
            }
        }
    }

    if words.is_empty() {
        return Some((0, 0.0));
    }
    let mut n = 1u32;
    let mut line_x = words[0].width;
    let mut line_lh = strut_lh.max(words[0].lh);
    let mut total = 0.0f64;
    for w in &words[1..] {
        let with_space = line_x + w.space_w; // space_before is always true here (else we declined)
        let _ = w.space_before;
        if with_space + w.width > content_w {
            total += line_lh; // close the line
            n += 1;
            line_x = w.width; // break eats the space; the word starts the new line
            line_lh = strut_lh.max(w.lh);
        } else {
            line_x = with_space + w.width;
            line_lh = line_lh.max(w.lh);
        }
    }
    total += line_lh;
    Some((n, total))
}

// A UTF-16 unit whose code point is a wide/CJK character (its own break unit) — a lone BMP unit, or a
// high surrogate (astral chars are wide too). Used to decline CJK text in the L2 breaker.
fn is_wide_unit(u: u16) -> bool {
    let cp = u as u32;
    (0x1100..=0x115F).contains(&cp)
        || (0x2E80..=0xA4CF).contains(&cp)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE6F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0xFFE0..=0xFFE6).contains(&cp)
        || (0xD800..=0xDBFF).contains(&u) // astral (emoji etc.) — full-width, own unit
}

// A collapsing-margin SET: the largest positive and the smallest (most negative) adjoining margins.
// Its used value is `pos + neg` (CSS 2.1 §8.3.1), which is why adjoining margins DON'T sum.
#[derive(Clone, Copy)]
struct CMargin {
    pos: f64,
    neg: f64,
}
impl CMargin {
    fn new() -> Self {
        CMargin { pos: 0.0, neg: 0.0 }
    }
    fn of(m: f64) -> Self {
        let mut c = CMargin::new();
        c.add(m);
        c
    }
    fn add(&mut self, m: f64) {
        if m > self.pos {
            self.pos = m;
        }
        if m < self.neg {
            self.neg = m;
        }
    }
    fn merge(&mut self, o: CMargin) {
        if o.pos > self.pos {
            self.pos = o.pos;
        }
        if o.neg < self.neg {
            self.neg = o.neg;
        }
    }
    fn value(&self) -> f64 {
        self.pos + self.neg
    }
}

// What a measured node exposes to its parent: its collapsed top and bottom margins (each a set, so the
// parent can go on collapsing), and whether the node collapses THROUGH (empty, no border/padding/height
// — its top and bottom margins are one and the same, and adjoining margins pass straight through it).
struct MInfo {
    top: CMargin,
    bottom: CMargin,
    collapse_through: bool,
}

// Measure node `i` at border-box width `w`: lay its subtree out RELATIVE to `i`'s border-box top-left
// (children's boxes get relative x/y; `i`'s own x/y are left for the caller), set `i`'s box w/h, and
// return `i`'s collapsed margins. Implements block-flow margin collapsing: adjoining sibling margins
// collapse; a parent's top/bottom margin collapses with its first/last in-flow child's when that edge
// is "open" (no border, no padding — and, for the bottom, an auto height); an empty block collapses
// through.
fn measure(
    i: usize,
    w: f64,
    inputs: &[Input],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> MInfo {
    let n = inputs[i];
    let content_top_rel = n.bt + n.pt;
    let content_w = (w - n.edges_x()).max(0.0);

    // A text block (inline formatting context): its content height is the greedy line layout over its
    // run sequence, measured natively (font.rs) with no per-run crossing. It has no child records; its
    // runs are runs[run_start..run_start+run_count]. If it can't be measured (bad font / tab / combining
    // / CJK / mixed-font word), flag the pass for JS.
    if n.display == DISPLAY_TEXT_BLOCK {
        let (rs, re) = (n.run_start.max(0) as usize, (n.run_start + n.run_count).max(0) as usize);
        let content_h = if re <= runs.len() && rs <= re {
            match line_layout(&runs[rs..re], &run_texts[rs..re], n.strut_lh, content_w) {
                Some((_, h)) => h,
                None => {
                    failed.set(true);
                    0.0
                }
            }
        } else {
            failed.set(true);
            0.0
        };
        let box_h = if is_auto(n.height) {
            content_top_rel + content_h + n.pb + n.bb
        } else if n.border_box {
            n.height
        } else {
            n.height + n.edges_y()
        };
        let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_y() };
        let box_h = clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0);
        boxes[i].nid = n.nid;
        boxes[i].w = w;
        boxes[i].h = box_h;
        boxes[i].auto_height = is_auto(n.height);
        return MInfo { top: CMargin::of(Input::m(n.mt)), bottom: CMargin::of(Input::m(n.mb)), collapse_through: false };
    }

    let content_left_rel = n.bl + n.pl;
    let top_open = n.bt == 0.0 && n.pt == 0.0;
    let bottom_open = n.bb == 0.0 && n.pb == 0.0 && is_auto(n.height);

    let mut top_m = CMargin::of(Input::m(n.mt));
    let mut cursor = content_top_rel; // relative border-box bottom of the last non-collapse-through child
    let mut pending = CMargin::new(); // the collapsible margin sitting at `cursor`
    let mut first = true;
    let mut has_child = false;

    for &c in &children[i] {
        has_child = true;
        let cn = inputs[c];
        let child_w = resolve_width(&cn, content_w);
        let cm = measure(c, child_w, inputs, runs, run_texts, children, boxes, failed);
        boxes[c].x = content_left_rel + Input::m(cn.ml);
        if first && top_open {
            // The first in-flow child's top margin collapses with this node's top margin (collapse-
            // through the open top edge): it propagates up, and the child sits AT the content top.
            top_m.merge(cm.top);
            boxes[c].y = content_top_rel;
            if cm.collapse_through {
                pending = cm.top; // empty child: its single margin carries on to the next sibling
            } else {
                cursor = content_top_rel + boxes[c].h;
                pending = cm.bottom;
            }
        } else {
            pending.merge(cm.top); // collapse the previous trailing margin with this child's top margin
            let y = cursor + pending.value();
            boxes[c].y = y;
            if cm.collapse_through {
                pending.merge(cm.bottom); // pass adjoining margins straight through the empty child
            } else {
                cursor = y + boxes[c].h;
                pending = cm.bottom;
            }
        }
        first = false;
    }

    let mut bottom_m = CMargin::of(Input::m(n.mb));
    let box_h = if is_auto(n.height) {
        if !has_child {
            content_top_rel + n.pb + n.bb // empty block: just its own vertical edges (0 when all open)
        } else if bottom_open {
            // The last child's trailing margin collapses with this node's bottom margin (open bottom
            // edge, auto height): it propagates up rather than adding to the height.
            bottom_m.merge(pending);
            cursor + n.pb + n.bb
        } else {
            cursor + pending.value() + n.pb + n.bb // closed bottom: the trailing margin is contained
        }
    } else if n.border_box {
        n.height
    } else {
        n.height + n.edges_y()
    };
    let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_y() };
    let box_h = clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0);

    boxes[i].nid = n.nid;
    boxes[i].w = w;
    boxes[i].h = box_h;
    boxes[i].auto_height = is_auto(n.height);

    // An empty block with no border/padding and a zero auto height collapses through: its top and
    // bottom margins are one adjoining set that passes through to its neighbours.
    let collapse_through = is_auto(n.height)
        && !has_child
        && n.bt == 0.0
        && n.bb == 0.0
        && n.pt == 0.0
        && n.pb == 0.0
        && box_h == 0.0
        && is_auto(n.min_h);
    if collapse_through {
        top_m.merge(bottom_m);
        return MInfo { top: top_m, bottom: top_m, collapse_through: true };
    }
    MInfo { top: top_m, bottom: bottom_m, collapse_through: false }
}

// Convert the relative boxes to absolute document coordinates: add each node's absolute border-box
// origin to its children (whose x/y are relative to it), top-down in one pass.
fn place(i: usize, ax: f64, ay: f64, children: &[Vec<usize>], boxes: &mut [Box]) {
    boxes[i].x += ax;
    boxes[i].y += ay;
    let (bx, by) = (boxes[i].x, boxes[i].y);
    for &c in &children[i] {
        place(c, bx, by, children, boxes);
    }
}

// Resolve a block's BORDER-BOX width against containing-block content width `cb_w`. auto → fill the CB
// (minus this box's own horizontal margins); a declared width is content-box unless box-sizing:border-box,
// then converted to border-box; clamped by min/max (which are treated in the same box model).
fn resolve_width(n: &Input, cb_w: f64) -> f64 {
    let border_w = if is_auto(n.width) {
        // auto: fill the containing block, less horizontal margins (auto margins count 0 in L1).
        (cb_w - Input::m(n.ml) - Input::m(n.mr)).max(0.0)
    } else if n.border_box {
        n.width
    } else {
        n.width + n.edges_x()
    };
    // min/max-width are content-box in CSS unless border-box; convert to border-box for the clamp.
    let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_x() };
    clamp_min_max(border_w, to_border(n.min_w), to_border(n.max_w)).max(0.0)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn blk(nid: f64, parent: i32) -> Input {
        Input {
            nid,
            parent,
            display: DISPLAY_BLOCK,
            border_box: false,
            width: f64::NAN,
            height: f64::NAN,
            min_w: f64::NAN,
            max_w: f64::NAN,
            min_h: f64::NAN,
            max_h: f64::NAN,
            mt: 0.0,
            mr: 0.0,
            mb: 0.0,
            ml: 0.0,
            pt: 0.0,
            pr: 0.0,
            pb: 0.0,
            pl: 0.0,
            bt: 0.0,
            br: 0.0,
            bb: 0.0,
            bl: 0.0,
            run_start: -1,
            run_count: 0,
            strut_lh: 0.0,
        }
    }

    fn boxes(o: Outcome) -> Vec<Box> {
        match o {
            Outcome::LaidOut(b) => b,
            Outcome::Unsupported => panic!("unexpected Unsupported"),
        }
    }

    #[test]
    fn two_blocks_stack_with_explicit_heights() {
        // root (auto) > [a h=50, b h=30], width fills 800.
        let mut a = blk(1.0, 0);
        a.height = 50.0;
        let mut b = blk(2.0, 0);
        b.height = 30.0;
        let inputs = vec![blk(0.0, -1), a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1], Box { nid: 1.0, x: 0.0, y: 0.0, w: 800.0, h: 50.0, auto_height: false });
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 50.0, w: 800.0, h: 30.0, auto_height: false });
        assert_eq!(bx[0].h, 80.0); // root auto height = 50 + 30
        assert!(bx[0].auto_height);
    }

    #[test]
    fn margins_padding_border_stack() {
        // a: margin-top 10, padding 5 all, border 2 all, height auto, one child h=20.
        let mut a = blk(1.0, 0);
        a.mt = 10.0;
        a.pt = 5.0;
        a.pb = 5.0;
        a.pl = 5.0;
        a.pr = 5.0;
        a.bt = 2.0;
        a.bb = 2.0;
        a.bl = 2.0;
        a.br = 2.0;
        let mut c = blk(2.0, 1);
        c.height = 20.0;
        let inputs = vec![blk(0.0, -1), a, c];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 100.0));
        // a: y = 10 (margin), border-box width = 100 - 0 margins = 100, auto height = 20 + pt+pb+bt+bb = 20+14
        assert_eq!(bx[1].y, 10.0);
        assert_eq!(bx[1].w, 100.0);
        assert_eq!(bx[1].h, 34.0);
        // child: x = a.x + bl + pl = 7, y = a.y + bt + pt = 17, width = content = 100 - 14 = 86
        assert_eq!(bx[2].x, 7.0);
        assert_eq!(bx[2].y, 17.0);
        assert_eq!(bx[2].w, 86.0);
    }

    #[test]
    fn border_box_width_and_min_max() {
        let mut a = blk(1.0, 0);
        a.border_box = true;
        a.width = 200.0;
        a.max_w = 150.0;
        a.height = 40.0;
        let inputs = vec![blk(0.0, -1), a];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].w, 150.0); // clamped by max-width (border-box)
    }

    #[test]
    fn unsupported_subtree_declines() {
        let mut a = blk(1.0, 0);
        a.display = DISPLAY_UNSUPPORTED; // e.g. flex
        let inputs = vec![blk(0.0, -1), a];
        assert!(matches!(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
    }
}
