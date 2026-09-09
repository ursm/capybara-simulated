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
    // Margin-collapse basis, decided from the DECLARATION not the used size (mirrors the oracle's
    // `autoOrZeroHeight`): `height_adjoins` is true when `height` is `auto` or resolves to zero
    // (`height:0` / `0%` / …), i.e. the height does NOT keep the box's top and bottom margins apart —
    // a `height:0` box still adjoins, and an indefinite `%` height (used value auto) does NOT. Can't
    // come from the used `height` (0 and NaN can't tell these apart), so JS pushes the boolean.
    pub(crate) height_adjoins: bool,
    pub(crate) minh_adjoins: bool,
    // Text-block (DISPLAY_TEXT_BLOCK) fields. Its inline content is a RUN SEQUENCE (each run its own
    // font/size/spacing/line-height) in the `runs` buffer at [run_start, run_start+run_count); a run's
    // text is in `run_texts` at the run's index. `strut_lh` is the block's own resolved line-height and
    // `strut_asc` its baseline within that line box — the line-box STRUT each line grows from (a line's
    // box is max(ascent)+max(descent) over the strut and the runs on it, §10.8). Unused for a plain
    // block (run_count 0).
    pub(crate) run_start: i32,
    pub(crate) run_count: i32,
    pub(crate) strut_lh: f64,
    pub(crate) strut_asc: f64,
}

// Run kinds in a text block's inline stream. TEXT is a maximal same-font piece (its text in `run_texts`
// at the run's index); OPEN/CLOSE are an inline element's horizontal edges (open = left margin+border+
// padding, reserved in the fit test and flushed onto the first line content lands on; close = right
// border+padding+margin, added on the last line); BR is a `<br>` hard break.
pub(crate) const RUN_TEXT: u8 = 0;
pub(crate) const RUN_OPEN: u8 = 1;
pub(crate) const RUN_CLOSE: u8 = 2;
pub(crate) const RUN_BR: u8 = 3;

// One item of a text block's inline stream. For TEXT: font/size/ls/ws/line_height measure its words,
// and `asc` is the run's ascent within its line box (baselineWithin its owner) — its descent is
// `line_height - asc`, so a line's box height is max(asc)+max(descent) over its runs and the strut.
// For OPEN/CLOSE: `metric` is the horizontal edge width. `kind` selects.
#[derive(Clone, Copy)]
pub(crate) struct Run {
    pub(crate) kind: u8,
    pub(crate) font: i32,
    pub(crate) size: f64,
    pub(crate) ls: f64,
    pub(crate) ws: f64,
    pub(crate) line_height: f64,
    pub(crate) asc: f64,
    pub(crate) metric: f64,
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

// Greedy line layout for a text block's run/marker STREAM (`runs` / `run_texts` parallel, this block's
// slice). TEXT runs tokenize into words (maximal non-`[ \t\n\r\f]+` — NBSP is NOT a break), each measured
// in its own font; a collapsible space (the first ws at a boundary, that run's spaceW) is the break
// opportunity. OPEN/CLOSE are an inline element's horizontal edges: OPEN reserves `metric` in the fit
// test (openEdgeWidth) and flushes onto the first line content lands on; CLOSE adds `metric` on the
// current line. BR forces a line break. A line's box is max(ascent)+max(descent) over the STRUT
// (`strut_lh` / `strut_asc`) and the runs on it (each run's descent = line_height - asc), §10.8 — so a
// taller-metric run grows the box even under a fixed line-height; an empty line (a lone/leading `<br>`)
// is the bare strut (asc + desc == strut_lh). Returns (line count, total content height = Σ line
// heights). None when a construct isn't modelled — a tab / combining mark / CJK char, a WORD spanning
// two runs (no space at the boundary), or a `<br>` while an inline edge is open — so the caller declines to JS.
fn line_layout(runs: &[Run], run_texts: &[Option<Vec<u16>>], strut_lh: f64, strut_asc: f64, content_w: f64) -> Option<(u32, f64)> {
    let strut_desc = strut_lh - strut_asc;
    let mut line_x = 0.0f64;
    let mut total = 0.0f64;
    // The current line's box, seeded to the strut and grown by each placed run's ascent / descent.
    let mut line_asc = strut_asc;
    let mut line_desc = strut_desc;
    let mut line_has_content = false;
    let mut n = 1u32;
    // Open inline edges not yet closed: (pending-open width, already-flushed?). openEdgeWidth = Σ of the
    // unflushed pendings — reserved in the fit test until the first content flushes it onto the line.
    let mut open: Vec<(f64, bool)> = Vec::new();
    let mut pending_space: Option<f64> = None; // collapsed space before the next word
    let mut prev_was_word = false;

    for (ri, run) in runs.iter().enumerate() {
        match run.kind {
            RUN_OPEN => {
                open.push((run.metric, false));
                prev_was_word = false;
            }
            RUN_CLOSE => {
                open.pop(); // LIFO; an unflushed (empty-inline) open's pending is dropped, matching JS
                line_x += run.metric;
                if run.metric != 0.0 {
                    line_has_content = true;
                }
                prev_was_word = false;
            }
            RUN_BR => {
                if !open.is_empty() {
                    return None; // <br> inside an open inline edge (fragment) — defer to JS
                }
                total += line_asc + line_desc; // an empty line's box is the bare strut
                n += 1;
                line_x = 0.0;
                line_asc = strut_asc;
                line_desc = strut_desc;
                line_has_content = false;
                pending_space = None;
                prev_was_word = false;
            }
            RUN_TEXT => {
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
                        // A space is a break opportunity, unless it is leading whitespace on a fresh line
                        // (dropped). Collapse consecutive / boundary spaces to the FIRST seen.
                        if line_has_content && pending_space.is_none() {
                            pending_space = Some(space_w);
                        }
                    } else {
                        let start = i;
                        while i < text.len() && !is_ws_u16(text[i]) {
                            i += 1;
                        }
                        let width = measure_word(run, &text[start..i])?;
                        let (space_before, sw) = match pending_space.take() {
                            Some(s) => (true, s),
                            None => (false, 0.0),
                        };
                        if prev_was_word && !space_before {
                            return None; // a word spans two runs with no space between (mixed-font word)
                        }
                        if space_before && line_has_content {
                            line_x += sw; // hanging space
                        }
                        let ow: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                        if line_has_content && space_before && line_x + ow + width > content_w {
                            total += line_asc + line_desc; // break: close the line (the hanging space is dropped)
                            n += 1;
                            line_x = 0.0;
                            line_asc = strut_asc;
                            line_desc = strut_desc;
                            // line_has_content is set true just below as the word is placed on the new line
                        }
                        // Flush the still-open edges onto this line (once), then place the word.
                        for o in open.iter_mut() {
                            if !o.1 {
                                line_x += o.0;
                                o.1 = true;
                            }
                        }
                        line_x += width;
                        line_asc = line_asc.max(run.asc);
                        line_desc = line_desc.max(run.line_height - run.asc);
                        line_has_content = true;
                        prev_was_word = true;
                    }
                }
            }
            _ => return None, // unknown run kind
        }
    }

    if line_has_content {
        total += line_asc + line_desc; // close the final line (a trailing <br>'s fresh empty line is NOT closed)
    }
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
// `top_only` is the run ABOVE the box's own bottom margin — its top margin joined with its first
// children's, but NOT its own bottom (§8.3.1). It equals `top` for a non-through box; for a through box
// it is where the box is PLACED (its bottom margin still folds on to the next sibling), the oracle's
// `topOnly` — so a `margin-top:5; margin-bottom:40` empty spacer sits 5 below, not 40.
struct MInfo {
    top: CMargin,
    top_only: CMargin,
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
            match line_layout(&runs[rs..re], &run_texts[rs..re], n.strut_lh, n.strut_asc, content_w) {
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
        let top = CMargin::of(Input::m(n.mt));
        return MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false };
    }

    let content_left_rel = n.bl + n.pl;
    let top_open = n.bt == 0.0 && n.pt == 0.0;
    // §8.3.1: the bottom margin adjoins the last child's only where the box has no bottom border/padding
    // and its height does not keep them apart — asked of the DECLARATION (`height_adjoins`, so a
    // `height:0` box still adjoins) rather than the used size.
    let bottom_open = n.bb == 0.0 && n.pb == 0.0 && n.height_adjoins;

    let mut top_m = CMargin::of(Input::m(n.mt));
    let mut cursor = content_top_rel; // relative border-box bottom of the last non-collapse-through child
    let mut pending = CMargin::new(); // the collapsible margin sitting at `cursor`
    let mut first = true;
    let mut has_child = false;
    let mut all_children_through = true; // every in-flow child so far collapsed through (empty when childless)

    for &c in &children[i] {
        has_child = true;
        let cn = inputs[c];
        let child_w = resolve_width(&cn, content_w);
        let cm = measure(c, child_w, inputs, runs, run_texts, children, boxes, failed);
        if !cm.collapse_through {
            all_children_through = false;
        }
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
            // Place at the run ABOVE the child's own bottom (top_only) — for a through child that is its
            // top margin only, so its bottom does not push it down; for a normal child top_only == top.
            pending.merge(cm.top_only);
            let y = cursor + pending.value();
            boxes[c].y = y;
            if cm.collapse_through {
                pending.merge(cm.bottom); // then the child's bottom folds on to the next sibling
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

    // §8.3.1: a block collapses THROUGH — its top and bottom margins are one adjoining set that passes
    // to its neighbours — when it has no border/padding, an adjoining height and min-height (auto or
    // zero, per the DECLARATION), a zero box, and every in-flow child itself collapses through (so a
    // childless empty block, and a wrapper whose children are all empty, both collapse; a text-block or
    // sized child stops it). Mirrors the oracle's `marginInfo(el).through`.
    let collapse_through = n.height_adjoins
        && n.minh_adjoins
        && all_children_through
        && n.bt == 0.0
        && n.bb == 0.0
        && n.pt == 0.0
        && n.pb == 0.0
        && box_h == 0.0;
    if collapse_through {
        let top_only = top_m; // the top run alone — where this box is placed
        top_m.merge(bottom_m); // the run it hands up and down is top and bottom joined
        return MInfo { top: top_m, top_only, bottom: top_m, collapse_through: true };
    }
    MInfo { top: top_m, top_only: top_m, bottom: bottom_m, collapse_through: false }
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
            height_adjoins: true, // auto height/min-height adjoin (autoOrZeroHeight); overridden per test
            minh_adjoins: true,
            run_start: -1,
            run_count: 0,
            strut_lh: 0.0,
            strut_asc: 0.0,
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
        // a is the first child of an OPEN-top root, so its margin-top collapses through the root and is
        // absorbed (§8.3.1) — a sits at the root's content top (y = 0), not pushed down by its own margin.
        // (This is what a body's first child does — the margin escapes to the top; the JS layout puts
        // body._lb there so native matches.) Border-box width = 100 - 0 margins = 100; auto height =
        // 20 + pt+pb+bt+bb = 34.
        assert_eq!(bx[1].y, 0.0);
        assert_eq!(bx[1].w, 100.0);
        assert_eq!(bx[1].h, 34.0);
        // child: x = a.x + bl + pl = 7, y = a.y + bt + pt = 7, width = content = 100 - 14 = 86
        assert_eq!(bx[2].x, 7.0);
        assert_eq!(bx[2].y, 7.0);
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
    fn declared_zero_height_empty_block_collapses_through() {
        // root > [A h:50; B h:0 mt:20 mb:40 (no bp, no children); C h:30]. A `height:0` box still adjoins
        // (§8.3.1), so B collapses through: A.mb/B.mt/B.mb/C.mt collapse to one 40px run. B sits at its
        // top-only (70), C follows the whole run (90). Regresses if collapse-through gates on `auto` alone.
        let mut a = blk(1.0, 0);
        a.height = 50.0;
        a.height_adjoins = false;
        let mut b = blk(2.0, 0);
        b.height = 0.0;
        b.height_adjoins = true; // height:0 adjoins (autoOrZeroHeight)
        b.mt = 20.0;
        b.mb = 40.0;
        let mut c = blk(3.0, 0);
        c.height = 30.0;
        c.height_adjoins = false;
        let inputs = vec![blk(0.0, -1), a, b, c];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[2].y, 70.0); // B placed at its top-only run (A.mb 0 vs B.mt 20)
        assert_eq!(bx[2].h, 0.0);
        assert_eq!(bx[3].y, 90.0); // C after the collapsed 40px run
        assert_eq!(bx[0].h, 120.0);
    }

    #[test]
    fn wrapper_whose_children_all_collapse_through_collapses_through() {
        // root > [A h:50 mb:10; P(auto, no bp, mt:30 mb:5) > empty div; C h:30 mt:20]. P has a child but
        // that child collapses through, so P does too: A.mb/P.mt/P.mb/C.mt collapse to 30 → C.y = 80.
        // Regresses if collapse-through requires a childless box.
        let mut a = blk(1.0, 0);
        a.height = 50.0;
        a.height_adjoins = false;
        a.mb = 10.0;
        let mut p = blk(2.0, 0); // auto height, no border/padding
        p.mt = 30.0;
        p.mb = 5.0;
        let empty = blk(3.0, 2); // P's only child, empty → collapses through
        let mut c = blk(4.0, 0);
        c.height = 30.0;
        c.height_adjoins = false;
        c.mt = 20.0;
        let inputs = vec![blk(0.0, -1), a, p, empty, c];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[4].y, 80.0); // C after the run collapsed through the empty wrapper
    }

    #[test]
    fn unsupported_subtree_declines() {
        let mut a = blk(1.0, 0);
        a.display = DISPLAY_UNSUPPORTED; // e.g. flex
        let inputs = vec![blk(0.0, -1), a];
        assert!(matches!(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
    }
}
