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
pub(crate) const DISPLAY_FLEX: u8 = 3;
// CSS Tables 3 (t1): the table box and its internal structure. Cells are ordinary block / text blocks
// (DISPLAY_BLOCK / DISPLAY_TEXT_BLOCK) sized by the oracle (pushed), so they need no code of their own.
pub(crate) const DISPLAY_TABLE: u8 = 4;
pub(crate) const DISPLAY_TABLE_ROW_GROUP: u8 = 5;
pub(crate) const DISPLAY_TABLE_ROW: u8 = 6;
// A table CAPTION keeps its own block / text display (measure lays out its subtree); it is identified
// structurally as the table's only non-row/non-group child (t4), not by a display code.
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
    // Float positioning (§9.5), resolved JS-side to pure rectangle arithmetic. `float_kind` 0 none /
    // 1 left / 2 right; `clear` 0 none / 1 left / 2 right / 3 both. `starts_bfc` marks a block that owns
    // a float context (a float never crosses this boundary) AND establishes a block formatting context,
    // so its own margins do NOT collapse with its children's (§8.3.1). For a floated box, its used width
    // rides `width` (JS resolves the shrink-to-fit; native computes the auto height from the subtree).
    pub(crate) float_kind: u8,
    pub(crate) clear: u8,
    pub(crate) starts_bfc: bool,
    // Flex (§9.7) — the SIZING is resolved JS-side (each item's used main+cross size rides its
    // width/height, like a float's shrink-to-fit width), so native does only PLACEMENT. On a flex
    // CONTAINER: `flex_justify` (main-axis distribution) 0 start / 1 center / 2 end / 3 space-between /
    // 4 space-around / 5 space-evenly, and `flex_main_gap` (px). On a flex ITEM: `flex_cross_align`
    // 0 start-or-stretch / 1 center / 2 end (the item's used cross size already fills the line, so
    // stretch folds to a zero offset).
    pub(crate) flex_justify: u8,
    pub(crate) flex_main_gap: f64,
    pub(crate) flex_cross_align: u8,
    // Flex main axis: true = row (main is X / width), false = column (main is Y / height). The item
    // main/cross sizes swap accordingly; both come pushed.
    pub(crate) flex_main_is_x: bool,
    // Flex wrap: false = nowrap (one line, fills the cross), true = wrap (multi-line, align-content stacks
    // the lines). `flex_align_content` 0 start / 1 center / 2 end / 3 space-between / 4 space-around /
    // 5 space-evenly / 6 stretch — but stretch's GROW is already baked into the pushed item cross sizes,
    // so native only positions the lines (lead/between). `flex_cross_gap` is the px gap between lines.
    pub(crate) flex_wrap: bool,
    pub(crate) flex_align_content: u8,
    pub(crate) flex_cross_gap: f64,
    // Main axis reversed (row-reverse / column-reverse / rtl-row): the main axis runs from the FAR
    // physical edge back toward the near one. The abstract (main-start-relative) placement is unchanged;
    // only the final physical mapping mirrors, and the leading margin is the main-start-side one. The cross
    // axis is always FORWARD in this increment (rtl-column / wrap-reverse / vertical are bailed).
    pub(crate) flex_main_reverse: bool,
    // `position: relative` offset (§9.4.3), resolved JS-side (relativeOffset). It moves the box and its
    // subtree at PAINT time without touching the flow, so `place` adds it after the absolute origin; the
    // flow (margin collapse, sibling positions, float bands) is computed from the unshifted position. 0 for
    // a non-relative box.
    pub(crate) rel_x: f64,
    pub(crate) rel_y: f64,
    // A flex ITEM's AUTO margins. MAIN axis (§9.5): bit0 = main-start-side `auto`, bit1 = main-end-side —
    // these absorb the line's free space (free/autos each) before justify-content, which then yields
    // (ZERO_JUSTIFY). CROSS axis (§8.1): bit2 = cross-start-side `auto`, bit3 = cross-end-side — these eat
    // the line's leftover (autoMarginSplit) and win over align-self. Sides are resolved JS-side through the
    // flex axis + main-reverse, so a given bit is always the abstract start/end margin native expects.
    pub(crate) flex_item_auto: u8,
    // A flex ITEM aligned on the baseline (flex_cross_align == 3): its FIRST-baseline ascent within its
    // MARGIN box (the oracle's baselineParts.asc — own baseline offset + top margin, or the bottom margin
    // edge when the item has no line to give), resolved JS-side. NaN for a non-baseline item.
    pub(crate) flex_baseline_asc: f64,
    // An OUT-OF-FLOW flex child (position:absolute / fixed, §4.1): 1 = out of flow. It is removed from flex
    // sizing and flow — its subtree lays out at its pushed border box, and it is placed at the container's
    // border-box origin + its resolved displacement (rel_x/rel_y = el._lb − container._lb), so the insets /
    // static position the oracle already resolved are replayed. 0 = an ordinary in-flow item.
    pub(crate) out_of_flow: u8,
    // TABLE border-spacing (§17.6.1), set only on a DISPLAY_TABLE node (0 elsewhere). The cell sizes (the
    // column widths × row heights) are pushed like flex-item sizes; native reassembles the tracks and
    // prefix-sums them with this spacing to position every cell, row, row-group, and the table box itself.
    pub(crate) sp_x: f64,
    pub(crate) sp_y: f64,
    // A table CELL's grid placement (t2 spans): its starting COLUMN (the Nth cell in a row is NOT at column N
    // once a colspan or a rowspan-from-above shifts it, so the oracle's resolved col is pushed) and its
    // colspan / rowspan. Tracks (column widths / row heights) are derived only from NON-spanning cells
    // (colspan==1 / rowspan==1); a spanning cell sits at col_x[col] / row_top[row] with its pushed spanned
    // size (= Σ spanned tracks + internal spacing, checked by the safety net). 0 / 1 / 1 on a non-cell node.
    pub(crate) cell_col: usize,
    pub(crate) cell_colspan: usize,
    pub(crate) cell_rowspan: usize,
    // (border-collapse needs no flag here: the oracle resolves the whole collapsed-border model and pushes it as
    // ordinary edges — border-spacing 0, each cell's halved borders in its pushed box, and the table's OWN border
    // set to the outer half of its rim cells' borders with no padding — so `measure_table` lays a collapse table
    // out exactly like a separate one.)
    // Caption placement (t4), on a DISPLAY_TABLE node that has a caption child: 0 = caption-side top (the grid
    // is offset down by the caption's height), 1 = bottom (the caption sits below the grid). The caption's box
    // is pushed like a cell; the `<table>` el._lb is then the WRAPPER (caption + grid). 0 when no caption.
    pub(crate) caption_side: u8,
    // direction: rtl on a block container (r1). Its in-flow block children are placed from the inline-start =
    // RIGHT edge: x = content_left + content_w - child_border_width - margin_right (which reduces to the ltr
    // content_left + margin_left for a block that FILLS the width, so one formula serves both). 0 = ltr. The
    // harness bails an rtl block with floats or auto horizontal margins, so only this placement differs.
    pub(crate) rtl: u8,
    // vertical-align on a table CELL: the px the oracle moved the cell's content down by within its (row-tall)
    // box (0 for top / a content that fills the row). The oracle already resolved top/middle/bottom into this
    // scalar; native lays cell content top-aligned, then shifts the cell's own child boxes down by it to match.
    pub(crate) cell_va_offset: f64,
    // A flex container's anonymous-item cross floor: the line-height of any bare (non-whitespace) text directly
    // inside it (0 when there is none). The oracle does not lay that text out as a real flex item, it only
    // floors the container's AUTO cross size at this line-height (`anonymousItemHeight`); native does the same.
    pub(crate) anon_cross: f64,
    // `white-space: nowrap` on a text block: whitespace still collapses, but the line never SOFT-wraps — only a
    // `<br>` breaks it. The line grows past the content width; the block's height is the strut (one line, or one
    // per <br>). (pre / pre-wrap / pre-line, which preserve whitespace, still decline in the harness.)
    pub(crate) no_wrap: bool,
}

pub(crate) const CROSS_BASELINE: u8 = 3;
pub(crate) const CROSS_BASELINE_LAST: u8 = 4;

pub(crate) const FLOAT_LEFT: u8 = 1;
pub(crate) const FLOAT_RIGHT: u8 = 2;
// `clear` 1/2 (left/right) align with FLOAT_LEFT/FLOAT_RIGHT so clearance_y compares against a float's
// side directly; CLEAR_BOTH clears either side.
pub(crate) const CLEAR_BOTH: u8 = 3;

// Run kinds in a text block's inline stream. TEXT is a maximal same-font piece (its text in `run_texts`
// at the run's index); OPEN/CLOSE are an inline element's horizontal edges (open = left margin+border+
// padding, reserved in the fit test and flushed onto the first line content lands on; close = right
// border+padding+margin, added on the last line); BR is a `<br>` hard break.
pub(crate) const RUN_TEXT: u8 = 0;
pub(crate) const RUN_OPEN: u8 = 1;
pub(crate) const RUN_CLOSE: u8 = 2;
pub(crate) const RUN_BR: u8 = 3;
// An ATOMIC inline (an inline replaced element — svg / img / a control): a single box on the line. `metric`
// is its margin-box width (advance), `asc` its ascent above the line baseline, `line_height` its full
// margin-box height (asc + descent). Placed like an unbreakable word; grows the line box by asc / descent.
pub(crate) const RUN_ATOMIC: u8 = 4;

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
            if p < inputs.len()
                && matches!(
                    n.display,
                    DISPLAY_BLOCK
                        | DISPLAY_TEXT_BLOCK
                        | DISPLAY_FLEX
                        | DISPLAY_TABLE
                        | DISPLAY_TABLE_ROW_GROUP
                        | DISPLAY_TABLE_ROW
                )
            {
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
    let mut root_fc = FloatCtx::new();
    measure(0, root_w, inputs, runs, run_texts, &children, &mut boxes, &failed, &mut root_fc, 0.0, 0.0);
    if failed.get() {
        return Outcome::Unsupported;
    }
    place(0, root_x, root_y, inputs, &children, &mut boxes);
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
//
// FLOATS (§9.5): when `floats` is non-empty the block's lines route around them. Each line's usable width
// is the band at its flow position `top + total` (owner frame; `cl`/`cr` are the block's content edges
// there), queried at `strut_lh` tall (the oracle's `lineHeightOf`, not the grown line box); an empty line
// whose first word won't fit the band DROPS below the shallowest float squeezing it (float_fit_y). When
// `floats` is empty the width is `content_w` exactly, so the no-float path is bit-identical to before.
fn line_layout(
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    strut_lh: f64,
    strut_asc: f64,
    content_w: f64,
    floats: &[FloatItem],
    cl: f64,
    cr: f64,
    top: f64,
    no_wrap: bool,
) -> Option<(u32, f64)> {
    let strut_desc = strut_lh - strut_asc;
    // The usable width of the line whose top is at `top + t` — the float band there, or the full content
    // width when there are no floats (kept exact, not `cr - cl`, so the no-float path never drifts).
    let band_w = |t: f64| -> f64 {
        if floats.is_empty() {
            content_w
        } else {
            let (bl, br) = float_band(floats, top + t, strut_lh, cl, cr);
            br - bl
        }
    };
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
    // An atomic inline is a break opportunity on BOTH sides regardless of whitespace: this flag carries the
    // AFTER-side break (a zero-width break opportunity) to the next box, so a word glued to an atomic can still
    // wrap before it. (The BEFORE-side break is unconditional in the RUN_ATOMIC arm itself.) Reset on any word
    // placement and at a line break.
    let mut atomic_break = false;

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
                atomic_break = false;
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
                        // A break opportunity precedes this word at a collapsed space OR right after an atomic —
                        // but `white-space: nowrap` never SOFT-wraps (only <br>), so the line grows past the band.
                        if !no_wrap && line_has_content && (space_before || atomic_break) && line_x + ow + width > band_w(total) {
                            total += line_asc + line_desc; // break: close the line (the hanging space is dropped)
                            n += 1;
                            line_x = 0.0;
                            line_asc = strut_asc;
                            line_desc = strut_desc;
                            line_has_content = false; // fresh line — its first word may still need to drop below a float
                        }
                        // An empty line whose first word won't fit the band drops below the float squeezing
                        // it (§9.5, "if a shortened line box is too small…"), growing the block by the gap. A
                        // `nowrap` line is NOT shortened by a float and never drops — it overlaps it on one line
                        // (the oracle does no float handling for a nowrap block), so skip this too.
                        if !no_wrap && !floats.is_empty() && !line_has_content && width + ow > band_w(total) {
                            let fy = top + total;
                            let at = float_fit_y(floats, fy, width + ow, cl, cr, strut_lh);
                            if at > fy {
                                total += at - fy;
                            }
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
                        atomic_break = false; // consumed the after-atomic break opportunity
                    }
                }
            }
            RUN_ATOMIC => {
                // A single box on the line — placed like an unbreakable word of width `metric`, growing the
                // line box by its own ascent / descent. An atomic is a break opportunity on BOTH sides
                // regardless of whitespace: it may break BEFORE it here (unconditional, on overflow), and it
                // sets `atomic_break` so the NEXT box may break before itself too.
                let width = run.metric;
                let (space_before, sw) = match pending_space.take() {
                    Some(s) => (true, s),
                    None => (false, 0.0),
                };
                if space_before && line_has_content {
                    line_x += sw; // hanging space
                }
                let ow: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                // An atomic is a break opportunity before it (§ line breaking) — but not under `white-space:
                // nowrap`, which never soft-wraps.
                if !no_wrap && line_has_content && line_x + ow + width > band_w(total) {
                    total += line_asc + line_desc; // break before the atomic (drop any hanging space)
                    n += 1;
                    line_x = 0.0;
                    line_asc = strut_asc;
                    line_desc = strut_desc;
                    line_has_content = false;
                }
                // A nowrap line is not shortened by / dropped below a float (see the word branch above).
                if !no_wrap && !floats.is_empty() && !line_has_content && width + ow > band_w(total) {
                    let fy = top + total;
                    let at = float_fit_y(floats, fy, width + ow, cl, cr, strut_lh);
                    if at > fy {
                        total += at - fy;
                    }
                }
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
                prev_was_word = false; // a box, not a word that can span two runs
                atomic_break = true; // a break opportunity follows this atomic
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

// The FLOAT CONTEXT of one block formatting context (§9.5): the margin boxes of the floats placed in
// it so far, in the OWNER's border-box frame (the frame `measure(owner)` lays its children in). A float
// never crosses a `starts_bfc` boundary, so each such block gets a fresh, empty context. `side` is
// FLOAT_LEFT / FLOAT_RIGHT.
#[derive(Clone, Copy)]
struct FloatItem {
    side: u8,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}
struct FloatCtx {
    items: Vec<FloatItem>,
}
impl FloatCtx {
    fn new() -> Self {
        FloatCtx { items: Vec::new() }
    }
}

// The band [l, r] a line or box of height `h` starting at `y` has to itself: the content edges
// [left, right] moved in by every float overlapping [y, y + max(h, 1)). Mirrors layout.js floatBand.
fn float_band(items: &[FloatItem], y: f64, h: f64, left: f64, right: f64) -> (f64, f64) {
    let mut l = left;
    let mut r = right;
    let bottom = y + h.max(1.0);
    for f in items {
        if f.bottom <= y || f.top >= bottom {
            continue;
        }
        if f.side == FLOAT_LEFT {
            if f.right > l {
                l = f.right;
            }
        } else if f.side == FLOAT_RIGHT && f.left < r {
            r = f.left;
        }
    }
    (l, r.max(l))
}

// The first y at or below `y` where a band of height `h` is at least `w` wide (§9.5.1 rule 3) — where a
// float that doesn't fit beside the ones there drops to, and where a line too narrow for its first word
// starts. The band only widens at a float bottom, so this scans those, not pixels. Mirrors floatFitY.
fn float_fit_y(items: &[FloatItem], y: f64, w: f64, left: f64, right: f64, h: f64) -> f64 {
    if items.is_empty() {
        return y;
    }
    let mut stops = vec![y];
    for f in items {
        if f.bottom > y {
            stops.push(f.bottom);
        }
    }
    stops.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for &at in &stops {
        let (bl, br) = float_band(items, at, h, left, right);
        if br - bl >= w {
            return at;
        }
    }
    *stops.last().unwrap()
}

// Where a box with `clear` starts: at or below every float bottom on the side(s) it named. Mirrors
// clearanceY (clear: CLEAR_LEFT / CLEAR_RIGHT / CLEAR_BOTH).
fn clearance_y(items: &[FloatItem], y: f64, clear: u8) -> f64 {
    let mut out = y;
    for f in items {
        if clear != CLEAR_BOTH && f.side != clear {
            continue;
        }
        if f.bottom > out {
            out = f.bottom;
        }
    }
    out
}

// The lowest edge any float reaches — what a box that CONTAINS its floats (started the context) grows
// to. -inf when there are none, so `max` with the flow bottom is a no-op. Mirrors floatsBottom.
fn floats_bottom(items: &[FloatItem]) -> f64 {
    let mut b = f64::NEG_INFINITY;
    for f in items {
        if f.bottom > b {
            b = f.bottom;
        }
    }
    b
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
    fc: &mut FloatCtx,
    // This node's border-box origin in the frame of the float context `fc` (its owner's border-box).
    // Used only by the text-block branch to place its lines around the floats; 0 when `fc` is empty.
    bfc_x: f64,
    bfc_y: f64,
) -> MInfo {
    let n = inputs[i];
    let content_top_rel = n.bt + n.pt;
    let content_w = (w - n.edges_x()).max(0.0);

    // A flex container (§9.7): the item SIZING is resolved JS-side (each item's used main/cross size rides
    // its width/height); native does only the placement — main-axis distribution + cross-axis alignment.
    if n.display == DISPLAY_FLEX {
        return measure_flex(i, w, inputs, runs, run_texts, children, boxes, failed);
    }

    // A TABLE (§17): the cell SIZING (column widths × row heights) is resolved JS-side and rides each cell's
    // record; native reassembles the tracks and positions every cell / row / row-group and the table box.
    if n.display == DISPLAY_TABLE {
        return measure_table(i, inputs, runs, run_texts, children, boxes, failed);
    }

    // A text block (inline formatting context): its content height is the greedy line layout over its
    // run sequence, measured natively (font.rs) with no per-run crossing. It has no child records; its
    // runs are runs[run_start..run_start+run_count]. If it can't be measured (bad font / tab / combining
    // / CJK / mixed-font word), flag the pass for JS.
    if n.display == DISPLAY_TEXT_BLOCK {
        // The block's content edges and top in the float context's (owner's) frame — the lines route
        // around any floats that overlap them. `fc.items` is empty for the ordinary text block, and then
        // line_layout uses the full content width (bit-identical to the no-float path).
        let cl = bfc_x + n.bl + n.pl;
        let cr = cl + content_w;
        let bfc_top = bfc_y + content_top_rel;
        let (rs, re) = (n.run_start.max(0) as usize, (n.run_start + n.run_count).max(0) as usize);
        let content_h = if re <= runs.len() && rs <= re {
            match line_layout(&runs[rs..re], &run_texts[rs..re], n.strut_lh, n.strut_asc, content_w, &fc.items, cl, cr, bfc_top, n.no_wrap) {
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
            n.height.max(n.edges_y())   // a border box is never smaller than its border+padding (content ≥ 0)
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
    // §8.3.1: a box that establishes a BLOCK FORMATTING CONTEXT (starts_bfc) keeps its children's
    // margins inside it — its own top/bottom edges never adjoin a child's margin, whatever the
    // border/padding/height. Otherwise the top edge is open with no border/padding, and the bottom edge
    // also needs an adjoining height (from the DECLARATION — `height:0` still adjoins).
    let top_open = !n.starts_bfc && n.bt == 0.0 && n.pt == 0.0;
    let bottom_open = !n.starts_bfc && n.bb == 0.0 && n.pb == 0.0 && n.height_adjoins;

    // Float context (owner frame = this measure frame): a block that establishes a BFC owns a FRESH one;
    // otherwise floats flow in from the context it inherits (`fc`). `cl`/`cr` are the content edges every
    // band query is measured against.
    let cl = content_left_rel;
    let cr = content_left_rel + content_w;
    let mut own = FloatCtx::new();
    let ctx: &mut FloatCtx = if n.starts_bfc { &mut own } else { fc };

    let mut top_m = CMargin::of(Input::m(n.mt));
    let mut cursor = content_top_rel; // relative border-box bottom of the last non-collapse-through child
    let mut pending = CMargin::new(); // the collapsible margin sitting at `cursor`
    let mut first = true;
    let mut has_child = false;
    let mut all_children_through = true; // every in-flow child so far collapsed through (empty when childless)

    for &c in &children[i] {
        let cn = inputs[c];
        if cn.out_of_flow != 0 {
            // §4.1: an absolute/fixed child neither sizes nor shifts the flow. Lay its subtree out at its pushed
            // border box (in a fresh context — it establishes a BFC) and reset its box to this block's origin;
            // `place` then positions it by rel_x/rel_y alone (el._lb − container._lb, the oracle's resolved
            // insets / static position). It touches no cursor / margin / has_child state.
            let cw = resolve_width(&cn, content_w);
            measure(c, cw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            boxes[c].x = 0.0;
            boxes[c].y = 0.0;
            continue;
        }
        if cn.float_kind != 0 {
            // A FLOAT is placed where the flow has reached (top0) but does NOT advance the flow cursor and
            // never collapses margins (§9.5.1 / §8.3.1); the lines/blocks after it route around it instead.
            // Its used width rode `width` (auto shrink-to-fit is bailed in the harness); its subtree lays
            // out in a fresh context (a float starts its own BFC).
            let top0 = cursor + pending.value();
            let fw = resolve_width(&cn, content_w);
            measure(c, fw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            let (fml, fmr, fmt, fmb) = (Input::m(cn.ml), Input::m(cn.mr), Input::m(cn.mt), Input::m(cn.mb));
            let outer = boxes[c].w + fml + fmr;
            let outer_h = boxes[c].h + fmt + fmb;
            let mut mtop = top0;
            if cn.clear != 0 {
                mtop = mtop.max(clearance_y(&ctx.items, mtop, cn.clear));
            }
            mtop = float_fit_y(&ctx.items, mtop, outer, cl, cr, outer_h);
            let top = mtop + fmt;
            let (band_l, band_r) = float_band(&ctx.items, mtop, outer_h, cl, cr);
            let x = if cn.float_kind == FLOAT_LEFT { band_l + fml } else { band_r - outer + fml };
            boxes[c].x = x;
            boxes[c].y = top;
            ctx.items.push(FloatItem {
                side: cn.float_kind,
                left: x - fml,
                right: x + boxes[c].w + fmr,
                top: mtop,
                bottom: top + boxes[c].h + fmb,
            });
            continue; // the flow cursor / first / has_child are untouched
        }
        let child_w = resolve_width(&cn, content_w);
        // A DIRECT text-block child coexisting with floats routes its lines around them (§9.5). Its
        // collapsed top is deterministic (a text block never collapses through, top_only == of(mt)), so it
        // can be placed BEFORE measuring — which the narrowing needs, to know each line's flow position in
        // the owner frame. Anything else in-flow beside a float (a block container, a cleared box) needs
        // the deferred machinery, so decline the whole pass.
        if !ctx.items.is_empty() {
            // A cleared child (§9.5.2) moves DOWN to below the floats it named — its margin collapses as
            // usual, then clearance replaces its position with the float bottom. When that clears past
            // EVERY float (all now above it), the child sees none, so it lays out normally below them; a
            // partial clear (a float remains on an uncleared side, still overlapping) defers to JS.
            if cn.clear != 0 {
                // Measure FIRST: a cleared child that clears past every float meets none, so it lays out
                // in a fresh empty context, and that layout is position-independent. The measure gives its
                // COLLAPSING top margin (cm.top_only) — its own margin joined with any a first descendant
                // folds through its open top edge — which is what the oracle advances the flow by
                // (collapsingTopMargin); the own declared margin alone would drop the descendant's.
                let cm = measure(c, child_w, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                if cm.collapse_through {
                    // A THROUGH cleared box is placed by a different rule (§8.3.1: its own above-margin sits
                    // ON TOP of the clearance line, and it does not advance the flow) — defer to JS.
                    failed.set(true);
                } else {
                    let y0 = if first && top_open {
                        top_m.merge(cm.top);
                        content_top_rel
                    } else {
                        pending.merge(cm.top_only);
                        cursor + pending.value()
                    };
                    let y = y0.max(clearance_y(&ctx.items, y0, cn.clear));
                    if y >= floats_bottom(&ctx.items) {
                        boxes[c].x = if n.rtl != 0 {
                            content_left_rel + content_w - boxes[c].w - Input::m(cn.mr)
                        } else {
                            content_left_rel + Input::m(cn.ml)
                        };
                        boxes[c].y = y;
                        cursor = y + boxes[c].h;
                        pending = cm.bottom;
                        all_children_through = false;
                        has_child = true;
                        first = false;
                        continue;
                    }
                    failed.set(true);
                }
            } else if cn.starts_bfc {
                // A child that ESTABLISHES a BFC does not OVERLAP the floats (§9.5): its whole border box is
                // placed in the band they leave and narrowed to it — the media-object shift, where a float and
                // a `flow-root` sibling read as two columns. The BFC barrier keeps its own top margin from
                // folding a descendant's through, so its collapsed top is deterministic. It is sized to the band
                // at that top (an auto width narrows to it, a declared one keeps its size); a box too WIDE for
                // the band drops below the float instead and re-places in the widened band below it.
                let (ml, mr) = (Input::m(cn.ml), Input::m(cn.mr));
                let t_top = CMargin::of(Input::m(cn.mt));
                let cy = if first && top_open {
                    top_m.merge(t_top);
                    content_top_rel
                } else {
                    pending.merge(t_top);
                    cursor + pending.value()
                };
                let (bl0, br0) = float_band(&ctx.items, cy, 1.0, cl, cr);
                let cw = resolve_width(&cn, (br0 - bl0).max(0.0));
                let cm = measure(c, cw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                let outer = boxes[c].w + ml + mr;
                let (y, bl, br) = if outer > br0 - bl0 {
                    let yy = float_fit_y(&ctx.items, cy, outer, cl, cr, boxes[c].h);
                    let (l, r) = float_band(&ctx.items, yy, boxes[c].h.max(1.0), cl, cr);
                    (yy, l, r)
                } else {
                    (cy, bl0, br0)
                };
                boxes[c].x = if n.rtl != 0 { br - boxes[c].w - mr } else { bl + ml };
                boxes[c].y = y;
                cursor = y + boxes[c].h;
                pending = cm.bottom;
                all_children_through = false;
                has_child = true;
                first = false;
                continue;
            } else if cn.display == DISPLAY_TEXT_BLOCK {
                // A DIRECT text-block child routes its lines around the floats. Its collapsed top is
                // deterministic (a text block never collapses through, top_only == of(mt)), so it can be
                // placed BEFORE measuring — which the narrowing needs, to know each line's owner-frame y.
                let t_top = CMargin::of(Input::m(cn.mt));
                let cy = if first && top_open {
                    top_m.merge(t_top);
                    content_top_rel
                } else {
                    pending.merge(t_top);
                    cursor + pending.value()
                };
                // In an rtl block a NARROWER text block sits at the inline-start = RIGHT (its right edge at
                // content_right - margin_right), mirroring the no-float placement below. A full-width one lands
                // back at content_left either way. `child_w` is its border box (`boxes[c].w` isn't set until the
                // measure below). Its lines still route around the floats through the shared `ctx`.
                let cx = if n.rtl != 0 {
                    content_left_rel + content_w - child_w - Input::m(cn.mr)
                } else {
                    content_left_rel + Input::m(cn.ml)
                };
                boxes[c].x = cx;
                boxes[c].y = cy;
                let cm = measure(c, child_w, inputs, runs, run_texts, children, boxes, failed, ctx, cx, cy);
                cursor = cy + boxes[c].h;
                pending = cm.bottom;
                all_children_through = false;
                has_child = true;
                first = false;
                continue;
            } else {
                // A block container beside a float (not cleared past it) needs the avoid/two-column
                // machinery — defer to JS.
                failed.set(true);
            }
        }
        has_child = true;
        let cm = measure(c, child_w, inputs, runs, run_texts, children, boxes, failed, ctx, 0.0, 0.0);
        if !cm.collapse_through {
            all_children_through = false;
        }
        // In an rtl block the in-flow children start at the RIGHT content edge (r1): the child's own right
        // edge sits at content_right - margin_right, so its left is that minus its width. A block that fills
        // the width lands back at content_left + margin_left, so this covers both. (This is the no-float path;
        // the float-context paths above mirror the same rtl placement for their own children.)
        boxes[c].x = if n.rtl != 0 {
            content_left_rel + content_w - boxes[c].w - Input::m(cn.mr)
        } else {
            content_left_rel + Input::m(cn.ml)
        };
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
        let flow_bottom = if !has_child {
            content_top_rel // empty block: just its own vertical edges (0 when all open)
        } else if bottom_open {
            // The last child's trailing margin collapses with this node's bottom margin (open bottom
            // edge, auto height): it propagates up rather than adding to the height.
            bottom_m.merge(pending);
            cursor
        } else {
            cursor + pending.value() // closed bottom: the trailing margin is contained
        };
        // A block that OWNS a float context CONTAINS its floats: its auto height grows to the lowest of
        // them (§9.5 — the `overflow:hidden` / `flow-root` clearfix). Only the owner grows; -inf else.
        let floats_to = if n.starts_bfc { floats_bottom(&ctx.items) } else { f64::NEG_INFINITY };
        flow_bottom.max(floats_to) + n.pb + n.bb
    } else if n.border_box {
        n.height.max(n.edges_y())   // a border box is never smaller than its border+padding (content box ≥ 0)
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
    let collapse_through = !n.starts_bfc
        && n.height_adjoins
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

// Native flex PLACEMENT for an LTR `row` OR `column` (§9.7), nowrap or wrap, main axis forward or reversed.
// The item SIZING is resolved JS-side — each item's used main and cross size rides its record (width/height,
// swapped by `flex_main_is_x`), like a float's shrink-to-fit width — so this only DISTRIBUTES the items on
// the MAIN axis (justify-content + gap + main-axis auto margins) and ALIGNS them on the CROSS axis
// (align-items/self + cross-axis auto margins), then sizes the container's own box (clamping a ROW's box
// height by min/max-height — two-phase, so an auto-height row's items stay content-aligned). Each item's
// subtree is laid out by the ordinary `measure` at its pushed border-box, in
// a fresh float context (an item is its own formatting context). Mirrors layoutFlexRow / layoutFlexColumn /
// stackFlexLines / crossAlignPhysical / autoMarginSplit. The harness bails rtl / vertical writing modes /
// baseline / a COLUMN's min-max clamp / wrap-reverse / unsupported-nested-flex / replaced.
fn measure_flex(
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
    let content_w = (w - n.edges_x()).max(0.0);
    let content_left_rel = n.bl + n.pl;
    let content_top_rel = n.bt + n.pt;
    let edges_y = n.edges_y();
    let main_is_x = n.flex_main_is_x; // row: main = X/width; column: main = Y/height
    let gap = n.flex_main_gap;
    let cnt = children[i].len();

    // Phase A — lay each item's subtree out at its pushed border-box (record order == flex order, the
    // harness sorted by `order`), each in a fresh float context.
    for &c in &children[i] {
        let iw = resolve_width(&inputs[c], content_w);
        measure(c, iw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
    }

    // Per-item OUTER extents (size + the two margins) along the main and cross axes, plus the leading
    // main/cross margin, parallel to `children[i]` (so the line logic never re-borrows `boxes`). The item
    // cross sizes are the FINAL (pushed, post-stretch) ones, so a line's cross already includes whatever
    // align-content:stretch grew it to — native positions the lines, it never re-grows them.
    let main_reverse = n.flex_main_reverse;
    let kids: Vec<usize> = children[i].clone();
    let (mut mo, mut co, mut ml_lead, mut cl_lead) = (Vec::with_capacity(cnt), Vec::with_capacity(cnt), Vec::with_capacity(cnt), Vec::with_capacity(cnt));
    for &c in &kids {
        let cn = inputs[c];
        // The LEADING main margin is the one on the main-START side, which a reversed axis puts on the far
        // physical side (a row-reverse item's leading margin is its right margin). The cross is forward here,
        // so the leading cross margin is the ordinary near-side one.
        if main_is_x {
            mo.push(boxes[c].w + Input::m(cn.ml) + Input::m(cn.mr));
            co.push(boxes[c].h + Input::m(cn.mt) + Input::m(cn.mb));
            ml_lead.push(Input::m(if main_reverse { cn.mr } else { cn.ml }));
            cl_lead.push(Input::m(cn.mt));
        } else {
            mo.push(boxes[c].h + Input::m(cn.mt) + Input::m(cn.mb));
            co.push(boxes[c].w + Input::m(cn.ml) + Input::m(cn.mr));
            ml_lead.push(Input::m(if main_reverse { cn.mb } else { cn.mt }));
            cl_lead.push(Input::m(cn.ml));
        }
    }

    // min/max-height (content-box in CSS unless border-box) as a border-box figure, for the clamps below.
    let to_border_y = |v: f64| if is_auto(v) || n.border_box { v } else { v + edges_y };

    // The container's MAIN content extent (the wrap capacity + the per-line justify basis): a row's is its
    // content width; a column's is its declared content height (clamped by min/max-height), or (auto) the
    // extent its items are justified within.
    // In-flow item positions (into `kids`). OUT-OF-FLOW children (abspos/fixed, §4.1) are removed from flex
    // sizing and line breaking — their subtrees are laid out in Phase A, but they are placed separately below.
    let flow: Vec<usize> = (0..cnt).filter(|&p| inputs[kids[p]].out_of_flow == 0).collect();
    let gap_total = gap * flow.len().saturating_sub(1) as f64;
    let sum_main: f64 = flow.iter().map(|&p| mo[p]).sum();
    let used_main = sum_main + gap_total; // the items are PUSHED (grow/shrink resolved), so this is final
    let content_main = if main_is_x {
        content_w
    } else if is_auto(n.height) {
        // A COLUMN's main is its HEIGHT; with the items already sized, the extent they are justified within
        // is a max-height CAPACITY the content overruns (items overflow it), else the content floored by
        // min-height (a min-height the items underflow IS a main size for justify to distribute —
        // `min-h-screen` on a page shell). No min/max → just the stacked items. (A wrapping column with a
        // min/max-height bails in the harness — this is its single line's extent.)
        let floor = if is_auto(n.min_h) { 0.0 } else { (to_border_y(n.min_h) - edges_y).max(0.0) };
        let cap = if is_auto(n.max_h) { f64::INFINITY } else { (to_border_y(n.max_h) - edges_y).max(0.0) };
        if used_main > cap { cap } else { used_main.max(floor) }
    } else {
        (clamp_min_max(to_border_y(n.height), to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0) - edges_y).max(0.0)
    };

    // Break into flex lines (positions into `kids`). Wrapping needs a DEFINITE main capacity: a row always
    // has one (its content width), but an AUTO-height column has none — the oracle keeps it a single line
    // structurally (capacity == null → never calls flexLines), so native must too rather than re-breaking
    // a summed capacity (which a FP-non-associative re-accumulation could trip into a spurious split).
    // nowrap is also one line holding everything; otherwise wrap greedily starts a new line when the next
    // item (plus the main gap) would overflow the main extent. Mirrors flexLines.
    let wrap_capacity = main_is_x || !is_auto(n.height);
    let lines: Vec<Vec<usize>> = if n.flex_wrap && wrap_capacity {
        let mut ls: Vec<Vec<usize>> = Vec::new();
        let mut cur: Vec<usize> = Vec::new();
        let mut used = 0.0;
        for &p in &flow {
            if !cur.is_empty() && used + gap + mo[p] > content_main {
                ls.push(std::mem::take(&mut cur));
                used = 0.0;
            }
            used += if cur.is_empty() { 0.0 } else { gap } + mo[p];
            cur.push(p);
        }
        ls.push(cur);
        ls
    } else {
        vec![flow.clone()]
    };
    let nlines = lines.len();
    // A line's natural cross size is the deepest of its PLAIN items' outers and its first-baseline GROUP's
    // extent. Baseline-aligned items (flex_cross_align == CROSS_BASELINE) share a baseline, so the group is
    // ONE thing: its extent is max(ascent) + max(outer - ascent) over its members, not the items taken singly
    // (a 32px word 29 above its baseline beside a text-less 60px box, whose baseline is its own bottom edge,
    // makes a 68px line, where max(37, 60) alone says 60). line_first_asc is the shared baseline the group
    // hangs from, reused at placement.
    // There are up to two baseline GROUPS on a line: `baseline` items share a FIRST baseline anchored at the
    // cross-START, `last baseline` items share a LAST baseline anchored at the cross-END (measured in an 80px
    // line: a 37px item sits at 0 for `baseline`, at 43 for `last baseline`). Each group's extent is
    // max(ascent) + max(outer - ascent) over its members; the line's natural cross is the deepest of the plain
    // outers and the two group extents. line_first_asc / line_last_asc + line_last_extent feed placement.
    let mut line_cross = vec![0.0f64; nlines];
    let mut line_first_asc = vec![0.0f64; nlines];
    let mut line_last_asc = vec![0.0f64; nlines];
    let mut line_last_extent = vec![0.0f64; nlines];
    for (li, line) in lines.iter().enumerate() {
        let (mut plain, mut fa, mut fb, mut la, mut lb) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for &p in line {
            let asc = inputs[kids[p]].flex_baseline_asc;
            match inputs[kids[p]].flex_cross_align {
                CROSS_BASELINE => { fa = fa.max(asc); fb = fb.max(co[p] - asc); }
                CROSS_BASELINE_LAST => { la = la.max(asc); lb = lb.max(co[p] - asc); }
                _ => plain = plain.max(co[p]),
            }
        }
        line_cross[li] = plain.max(fa + fb).max(la + lb);
        line_first_asc[li] = fa;
        line_last_asc[li] = la;
        line_last_extent[li] = la + lb;
    }

    // The container's CROSS content extent + its own box. The cross is a row's height (auto = the stacked
    // lines, else the declared content height) and a column's content width (always definite here).
    let cross_gap = n.flex_cross_gap;
    let lines_cross_sum: f64 = line_cross.iter().sum::<f64>() + cross_gap * nlines.saturating_sub(1) as f64;
    let (box_w, box_h, container_cross, definite_cross) = if main_is_x {
        // A ROW's cross is its HEIGHT, clamped by min/max-height — but the clamp is TWO-PHASE and hinges on
        // whether the height is declared (the oracle: `definiteCross = box.height !== 0 || autoHeight ===
        // false`, clamp applied in layoutElement). A DECLARED height is clamped BEFORE layout, so the items
        // align in the clamped cross (definite). An AUTO height is NOT: the items align in the CONTENT cross
        // (the stacked lines), and min/max-height then grows/shrinks the FINAL box around them WITHOUT moving
        // them — so container_cross stays the unclamped content (a min-height:100 app-shell row of a 30px
        // item keeps the item at the top and grows the box to 100; align-content sees free = 0).
        if is_auto(n.height) {
            // A bare-text anonymous item floors the row's auto cross at its line-height. Unlike a min-height
            // (clamped later, outside the flex pass), the oracle folds it into box.height HERE and reads
            // container_cross back from the grown box (layout.js: `containerCross = box.height - edges`), so the
            // single nowrap line grows to it and its items align WITHIN that floor — and a wrapping row shares
            // the surplus (anon − stacked) out through align-content. So container_cross carries the floor too,
            // not just box_h. (Pre-clamp, like the oracle: box.height is grown before the outer min/max clamp.)
            let bh = clamp_min_max(lines_cross_sum.max(n.anon_cross) + edges_y, to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0);
            (w, bh, lines_cross_sum.max(n.anon_cross), false)
        } else {
            let bh = clamp_min_max(to_border_y(n.height), to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0);
            (w, bh, (bh - edges_y).max(0.0), true)
        }
    } else {
        let bh = if is_auto(n.height) {
            // The box wraps what the items consumed OR the extent a min-height floored under them, then the
            // OUTER min/max-height clamp (a max-height the content overruns caps the box at it while the
            // items overflow — content_main holds the capped extent, used_main the overrunning content).
            // A bare-text anonymous item floors the box height (a column's MAIN) at its line-height, applied
            // after the items' extent exactly as the oracle's `max(contentExtent, anonymousItemHeight)`.
            clamp_min_max(content_main.max(used_main).max(n.anon_cross) + edges_y, to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0)
        } else {
            clamp_min_max(to_border_y(n.height), to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0)
        };
        (w, bh, content_w, true) // a column's cross (width) is always definite
    };

    // Per-line cross SIZE and cross-START. A NOWRAP line takes the whole container cross (§9.6 — a definite
    // cross fills it, an auto one is the line's own); a WRAP container stacks its lines by align-content
    // (the stretch GROW is already in the item sizes, so only the lead/between positioning is applied).
    let cross_start_base = if main_is_x { content_top_rel } else { content_left_rel };
    let mut line_lc = vec![0.0f64; nlines];
    let mut line_cs = vec![0.0f64; nlines];
    if !n.flex_wrap {
        line_lc[0] = if definite_cross { container_cross } else { line_cross[0].max(container_cross) };
        line_cs[0] = cross_start_base;
    } else {
        // free is measured from the FINAL (pushed) line crosses: for align-content:stretch a line whose
        // items already fill it (align-items stretch on an auto cross size) contributes its grown cross, so
        // free is 0 there and no grow is double-applied; a line of explicit-size items contributes its
        // natural cross, so the leftover grows the lines to position the later ones (§9.6).
        let (ac_lead, ac_between, ac_grow) = align_content(n.flex_align_content, container_cross - lines_cross_sum, nlines);
        let mut cross_at = cross_start_base + ac_lead;
        for li in 0..nlines {
            line_lc[li] = line_cross[li] + ac_grow;
            line_cs[li] = cross_at;
            cross_at += line_lc[li] + cross_gap + ac_between;
        }
    }

    // Place each line's items: MAIN axis by justify-content within the main extent (per line), CROSS axis by
    // align-items/self within the line's cross size.
    let main_start = if main_is_x { content_left_rel } else { content_top_rel };
    for (li, line) in lines.iter().enumerate() {
        let lc = line_lc[li];
        let cs = line_cs[li];
        let line_main: f64 = line.iter().map(|&p| mo[p]).sum::<f64>() + gap * line.len().saturating_sub(1) as f64;
        let free = content_main - line_main;
        // Auto main-axis margins take the line's free space (free/autos each) BEFORE justify-content, which
        // then yields — but only when there IS free space; with none they resolve to 0 and justify runs.
        let line_autos: usize = line.iter().map(|&p| (inputs[kids[p]].flex_item_auto & 1) as usize + ((inputs[kids[p]].flex_item_auto >> 1) & 1) as usize).sum();
        let each_auto = if line_autos > 0 && free > 0.0 { free / line_autos as f64 } else { 0.0 };
        let (m_lead, m_between) = if line_autos > 0 && free > 0.0 { (0.0, 0.0) } else { flex_distribution(n.flex_justify, free, line.len()) };
        let mut at = m_lead;
        for (k, &p) in line.iter().enumerate() {
            let c = kids[p];
            let auto = inputs[c].flex_item_auto;
            if k > 0 {
                at += gap + m_between;
            }
            if auto & 1 != 0 {
                at += each_auto; // auto main-start margin
            }
            at += ml_lead[p];
            let m_size = if main_is_x { boxes[c].w } else { boxes[c].h };
            // `at` is the item's abstract border-box start (from main-start). A forward axis maps it
            // straight off the near edge; a reversed axis mirrors it within the main extent (main-start is
            // the far physical edge).
            let main_pos = if main_reverse { main_start + (content_main - at - m_size) } else { main_start + at };
            at += mo[p] - ml_lead[p]; // advance past the item's main size + its trailing margin
            if auto & 2 != 0 {
                at += each_auto; // auto main-end margin
            }
            // A CROSS-axis auto margin (§8.1) eats the line's leftover and WINS over align-self, which
            // then has no free space left to place the item with (bit2 = cross-start-side auto, bit3 =
            // cross-end-side). `autoMarginSplit`: both auto centre, one auto pushes to the other edge, and
            // an over-constrained item (leftover <= 0) sits flush at the cross-start with a negative trail.
            let cross_pos = if auto & 0b1100 != 0 {
                let cross_box = if main_is_x { boxes[c].h } else { boxes[c].w };
                let lead_m = cl_lead[p];
                let trail_m = co[p] - cross_box - lead_m;
                let (lead_auto, trail_auto) = (auto & 4 != 0, auto & 8 != 0);
                let spare = lc - cross_box
                    - if lead_auto { 0.0 } else { lead_m }
                    - if trail_auto { 0.0 } else { trail_m };
                let lead = if spare <= 0.0 {
                    if lead_auto { 0.0 } else { lead_m }
                } else if lead_auto && trail_auto {
                    spare / 2.0
                } else if lead_auto {
                    spare
                } else {
                    lead_m
                };
                cs + lead
            } else {
                let off = match inputs[c].flex_cross_align {
                    1 => (lc - co[p]) / 2.0, // center
                    2 => lc - co[p],         // end
                    // baseline: hang from the line's shared baseline (the group's deepest ascent), so every
                    // member's own baseline coincides at line_first_asc. The FIRST-baseline group anchors at
                    // the cross-START; the LAST-baseline group anchors at the cross-END (groupTop = lc −
                    // lastExtent), both measured from their anchor.
                    CROSS_BASELINE => line_first_asc[li] - inputs[c].flex_baseline_asc,
                    CROSS_BASELINE_LAST => (lc - line_last_extent[li]) + line_last_asc[li] - inputs[c].flex_baseline_asc,
                    _ => 0.0,                // start / stretch
                };
                cs + off + cl_lead[p]
            };
            if main_is_x {
                boxes[c].x = main_pos;
                boxes[c].y = cross_pos;
            } else {
                boxes[c].y = main_pos;
                boxes[c].x = cross_pos;
            }
        }
    }

    // OUT-OF-FLOW children (§4.1): removed from the flow above, each is placed at the container's border-box
    // origin + its resolved displacement (rel_x/rel_y = el._lb − container._lb, replaying the insets or the
    // justify/align static position the oracle already resolved). Reset its box to the origin so `place`
    // positions it by rel_x/rel_y alone (over the container origin); its Phase-A subtree follows.
    for &c in &kids {
        if inputs[c].out_of_flow != 0 {
            boxes[c].x = 0.0;
            boxes[c].y = 0.0;
        }
    }

    boxes[i].nid = n.nid;
    boxes[i].w = box_w;
    boxes[i].h = box_h.max(0.0);
    boxes[i].auto_height = is_auto(n.height);
    let top = CMargin::of(Input::m(n.mt));
    MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false }
}

// How the LINES of a wrap container sit in its cross size (§9.6): (lead, between, grow). `stretch` (the
// default) hands the free space to the lines as GROW and positions them tight; the other keywords position
// with lead/between and don't grow. A stretch line whose items already fill it contributes 0 free (see the
// caller), so the grow is never double-applied. Mirrors alignContentLines (crossFlip / wrap-reverse bailed).
fn align_content(code: u8, free: f64, count: usize) -> (f64, f64, f64) {
    if code == 6 {
        return (0.0, 0.0, if free > 0.0 && count > 0 { free / count as f64 } else { 0.0 }); // stretch
    }
    let mut c = code;
    if free < 0.0 && (c == 3 || c == 4 || c == 5) {
        c = 0; // a distribution with no free space falls back to start
    }
    let (lead, between) = flex_distribution(c, free, count);
    (lead, between, 0.0)
}

// Main-axis free-space distribution → (leading offset before the first item, extra space between items).
// Mirrors the oracle's distributionOffsets: center/end apply even when free is negative (overflow);
// space-* collapse to 0 (start) when free is non-positive.
fn flex_distribution(code: u8, free: f64, n: usize) -> (f64, f64) {
    if n == 0 {
        return (0.0, 0.0);
    }
    match code {
        1 => (free / 2.0, 0.0), // center
        2 => (free, 0.0),       // end
        3 if free > 0.0 && n > 1 => (0.0, free / (n as f64 - 1.0)), // space-between
        4 if free > 0.0 => (free / n as f64 / 2.0, free / n as f64), // space-around
        5 if free > 0.0 => {
            let s = free / (n as f64 + 1.0); // space-evenly
            (s, s)
        }
        _ => (0.0, 0.0), // start (and space-* under non-positive free)
    }
}

// Native TABLE layout (§17, t1): a separate-borders, auto-layout table in normal flow — `table >
// (row-group | row)* > cell*`. Each cell's used border box (its column width × its unified row height) is
// PUSHED (rec[4]/rec[5], like a flex item); native reassembles the column/row TRACKS from the pushed cell
// sizes, prefix-sums them with border-spacing to position every cell, and DERIVES every row, row-group, and
// the table's OWN box — a table self-sizes from Σtracks + spacing, ignoring the width its block parent would
// give it. All boxes are written in their immediate parent's border-box frame; `place` composes the origins
// table → group → row → cell → content. Mirrors layoutTable / tableGapsWidth / tableGrid. Spans, captions,
// colgroup, thead/tfoot reorder, fixed layout, rtl AND border-collapse are all IN scope (the oracle folds the
// collapsed borders into the pushed edges, so a collapse table reassembles here exactly like a separate one).
// nlTableSupported declines only what native can't reassemble: rtl combined with a caption or a collapsed
// border, an imposed height the oracle didn't distribute into the rows, an empty or interleaved row group, a
// nested table, and a track only spanning cells cover.
fn measure_table(
    i: usize,
    inputs: &[Input],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> MInfo {
    let n = inputs[i];
    let (sx, sy) = (n.sp_x, n.sp_y);
    let bail = |failed: &std::cell::Cell<bool>| {
        failed.set(true);
        MInfo { top: CMargin::of(0.0), top_only: CMargin::of(0.0), bottom: CMargin::of(0.0), collapse_through: false }
    };

    // Flatten into rows + the group each belongs to. A table child is a ROW GROUP (its children are the
    // rows), a bare ROW, or the CAPTION (t4 — at most one, gated). Record order == render order (thead/tfoot
    // reorder is gated out, so it is document order here).
    let mut rows: Vec<usize> = Vec::new();
    let mut row_group: Vec<Option<usize>> = Vec::new();
    let mut caption: Option<usize> = None;
    for &ch in &children[i] {
        match inputs[ch].display {
            DISPLAY_TABLE_ROW_GROUP => {
                for &r in &children[ch] {
                    rows.push(r);
                    row_group.push(Some(ch));
                }
            }
            DISPLAY_TABLE_ROW => {
                rows.push(ch);
                row_group.push(None);
            }
            // The only other table child the walk emits is the CAPTION (a block / text box, at most one; the
            // gate enforces that), identified here by NOT being a row / row-group.
            _ => caption = Some(ch),
        }
    }
    let r_count = rows.len();
    if r_count == 0 {
        return bail(failed);
    }
    // The column count spans all cells: the last column any cell reaches (its start col + colspan). (t1's
    // "cells in row 0" breaks once a span shifts the grid.)
    let mut c_count = 0usize;
    for &r in &rows {
        for &c in &children[r] {
            c_count = c_count.max(inputs[c].cell_col + inputs[c].cell_colspan);
        }
    }
    if c_count == 0 {
        return bail(failed);
    }

    // Phase A — lay each cell's (and the caption's) subtree out at its pushed border box, in a fresh float
    // context. The caption is a block box spanning the table's BORDER box (pushed), positioned later.
    for &r in &rows {
        for &c in &children[r] {
            let iw = resolve_width(&inputs[c], 0.0);
            measure(c, iw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        }
    }
    if let Some(cap) = caption {
        let iw = resolve_width(&inputs[cap], 0.0);
        measure(cap, iw, inputs, runs, run_texts, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
    }
    // vertical-align: content laid out top-aligned above, moved down by the offset the oracle pushed (§17.5.3;
    // the UA default is `middle`). Shift the cell's direct children — their subtrees follow through `place`, and
    // text runs (not compared) need no shift; the cell BOX itself stays at the row top.
    for &r in &rows {
        for &c in &children[r] {
            let off = inputs[c].cell_va_offset;
            if off != 0.0 {
                for &ch in &children[c] {
                    boxes[ch].y += off;
                }
            }
        }
    }

    // Tracks: a column's width is the widest NON-spanning (colspan==1) cell in it, a row's height the tallest
    // rowspan==1 cell in it — a cell that SPANS several tracks can't size any one of them. This recovers the
    // tracks AND validates the grid; a column / row that no single-span cell covers is not reconstructible
    // (the oracle distributed a span across it) → decline.
    let mut col_w = vec![0.0f64; c_count];
    let mut col_seen = vec![false; c_count];
    let mut row_h = vec![0.0f64; r_count];
    let mut row_seen = vec![false; r_count];
    for (ri, &r) in rows.iter().enumerate() {
        for &c in &children[r] {
            let (col, cs, rs) = (inputs[c].cell_col, inputs[c].cell_colspan, inputs[c].cell_rowspan);
            if cs == 0 || rs == 0 || col + cs > c_count || ri + rs > r_count {
                return bail(failed); // a malformed / out-of-range span (shouldn't happen; be safe)
            }
            if cs == 1 {
                col_w[col] = col_w[col].max(boxes[c].w);
                col_seen[col] = true;
            }
            if rs == 1 {
                row_h[ri] = row_h[ri].max(boxes[c].h);
                row_seen[ri] = true;
            }
        }
    }
    if col_seen.iter().any(|&s| !s) || row_seen.iter().any(|&s| !s) {
        return bail(failed); // a track only spanning cells cover — native can't split it
    }

    // border-collapse:collapse (§17.6.2) needs no special frame here: the oracle folds each shared edge into
    // one border split between the two cells, and the table's OWN border (`n.bl`/`n.bt`/`n.br`/`n.bb`, pushed
    // from `edgeInsets`) is already the outer half of its rim cells' collapsed borders, with no padding. So a
    // collapse table self-sizes from its tracks + edges exactly like a separate one — only with border-spacing
    // 0 and the halved borders the oracle pushed.
    // The `<table>` el._lb is the WRAPPER (caption + grid). A caption-side:top caption offsets the whole grid
    // down by its own (pushed) height; a bottom one sits below the grid (placed later). The caption is a block
    // box spanning the table's BORDER box, outside the table's own border+padding (§17.4 wrapper box).
    let caption_h = caption.map(|cap| boxes[cap].h).unwrap_or(0.0);
    let caption_w = caption.map(|cap| boxes[cap].w).unwrap_or(0.0);
    let caption_top = caption.is_some() && n.caption_side == 0;
    let content_left = n.bl + n.pl;
    let content_top = n.bt + n.pt + if caption_top { caption_h } else { 0.0 };

    // Prefix sums (table-relative): a track's start is one border-spacing in, plus every earlier track + its
    // trailing spacing.
    let mut col_x = vec![0.0f64; c_count];
    let mut acc = content_left + sx;
    for ci in 0..c_count {
        col_x[ci] = acc;
        acc += col_w[ci] + sx;
    }
    let mut row_top = vec![0.0f64; r_count];
    let mut accy = content_top + sy;
    for ri in 0..r_count {
        row_top[ri] = accy;
        accy += row_h[ri] + sy;
    }
    let row_x = col_x[0];
    let row_w = col_x[c_count - 1] + col_w[c_count - 1] - row_x;

    // The table (WRAPPER) SELF-sizes from its grid tracks + spacing, unioned with the caption, plus its own
    // edges — not the width its parent passed. (Separate: spacing > 0. Collapse: spacing is 0 and the edges are
    // the outer-half frame. No caption: caption_h/_w are 0.)
    let sum_col: f64 = col_w.iter().sum();
    let sum_row: f64 = row_h.iter().sum();
    let grid_w = sum_col + (c_count as f64 + 1.0) * sx;
    let grid_h = sum_row + (r_count as f64 + 1.0) * sy;
    boxes[i].nid = n.nid;
    // The caption spans the BORDER box (the oracle pushed that width, edges included), so union it with the
    // grid's OWN border box rather than adding the table edges to it a second time.
    boxes[i].w = (grid_w + n.edges_x()).max(caption_w);
    boxes[i].h = grid_h + caption_h + n.edges_y();
    boxes[i].auto_height = false;

    // Place the caption at the table WRAPPER's border box (§17.4) — OUTSIDE the table's own border+padding: a top
    // caption at the wrapper's top edge (the grid is offset DOWN past it, via content_top), a bottom one just
    // below the table's bottom padding+border. Along the inline axis it sits at the wrapper's inline-start: the
    // left edge in LTR, and — for a caption NARROWER than the wrapper — the right edge in rtl (§10.3.3 balances
    // the leading margin). Native declines a caption MARGIN, so there is no lead to inset / centre it. Its Phase-A
    // subtree follows through `place`.
    if let Some(cap) = caption {
        boxes[cap].x = if n.rtl != 0 { boxes[i].w - boxes[cap].w } else { 0.0 };
        boxes[cap].y = if caption_top { 0.0 } else { n.bt + n.pt + grid_h + n.pb + n.bb };
    }

    // Row-group boxes (relative to the table): span their rows across the full row width.
    for &ch in &children[i] {
        if inputs[ch].display != DISPLAY_TABLE_ROW_GROUP {
            continue;
        }
        let mut first = None;
        let mut last = 0usize;
        for ri in 0..r_count {
            if row_group[ri] == Some(ch) {
                if first.is_none() {
                    first = Some(ri);
                }
                last = ri;
            }
        }
        if let Some(f) = first {
            boxes[ch].nid = inputs[ch].nid;
            boxes[ch].x = row_x;
            boxes[ch].y = row_top[f];
            boxes[ch].w = row_w;
            boxes[ch].h = row_top[last] + row_h[last] - row_top[f];
            boxes[ch].auto_height = false;
        }
    }

    // Row boxes (relative to their parent: the group box, else the table) + cell positions (relative to the
    // row). A cell's w/h are already the pushed track from Phase A.
    for (ri, &r) in rows.iter().enumerate() {
        let (gx, gy) = match row_group[ri] {
            Some(g) => (boxes[g].x, boxes[g].y),
            None => (0.0, 0.0),
        };
        boxes[r].nid = inputs[r].nid;
        boxes[r].x = row_x - gx;
        boxes[r].y = row_top[ri] - gy;
        boxes[r].w = row_w;
        boxes[r].h = row_h[ri];
        boxes[r].auto_height = false;
        for &c in &children[r] {
            let (col, cs, rs) = (inputs[c].cell_col, inputs[c].cell_colspan, inputs[c].cell_rowspan);
            // SAFETY NET: a cell's pushed border box must equal the tracks it spans plus the internal
            // border-spacing — colspan 1 / rowspan 1 reduce to "equals its own column / row". A grid the gate
            // let through that doesn't reconcile declines rather than mislay.
            let exp_w = col_w[col..col + cs].iter().sum::<f64>() + (cs as f64 - 1.0) * sx;
            let exp_h = row_h[ri..ri + rs].iter().sum::<f64>() + (rs as f64 - 1.0) * sy;
            if (boxes[c].w - exp_w).abs() > 0.01 || (boxes[c].h - exp_h).abs() > 0.01 {
                return bail(failed);
            }
            // The cell's position within the row (relative to it). An rtl table (r2) MIRRORS its columns —
            // column 0 is rightmost — so the cell's box is reflected within the row width: rel = row_w - ltr_rel
            // - cell_width (a colspan reflects by its own spanned width; the row / group / table boxes span the
            // whole grid and are direction-agnostic).
            let ltr_rel = col_x[col] - row_x;
            boxes[c].x = if n.rtl != 0 { row_w - ltr_rel - boxes[c].w } else { ltr_rel };
            boxes[c].y = 0.0;
        }
    }

    let top = CMargin::of(Input::m(n.mt));
    MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false }
}

// Convert the relative boxes to absolute document coordinates: add each node's absolute border-box
// origin to its children (whose x/y are relative to it), top-down in one pass — plus each node's
// `position: relative` offset, which moves it AND its subtree at paint time (the flow used the unshifted
// position, so only this pass, after the origin is added, applies the shift; children follow via `bx`/`by`).
fn place(i: usize, ax: f64, ay: f64, inputs: &[Input], children: &[Vec<usize>], boxes: &mut [Box]) {
    boxes[i].x += ax + inputs[i].rel_x;
    boxes[i].y += ay + inputs[i].rel_y;
    let (bx, by) = (boxes[i].x, boxes[i].y);
    for &c in &children[i] {
        place(c, bx, by, inputs, children, boxes);
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
        n.width.max(n.edges_x())   // a border box is never smaller than its border+padding (content box ≥ 0)
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
            float_kind: 0,
            clear: 0,
            starts_bfc: false,
            flex_justify: 0,
            flex_main_gap: 0.0,
            flex_cross_align: 0,
            flex_main_is_x: true, // row by default
            flex_wrap: false,
            flex_align_content: 6, // stretch
            flex_cross_gap: 0.0,
            flex_main_reverse: false,
            rel_x: 0.0,
            rel_y: 0.0,
            flex_item_auto: 0,
            flex_baseline_asc: f64::NAN,
            out_of_flow: 0,
            sp_x: 0.0,
            sp_y: 0.0,
            cell_col: 0,
            cell_colspan: 1,
            cell_rowspan: 1,
            caption_side: 0,
            rtl: 0,
            cell_va_offset: 0.0,
            anon_cross: 0.0,
            no_wrap: false,
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
    fn rtl_block_places_children_from_the_right() {
        // An rtl root (width 300) with a narrow fixed-width child (100, margin-right 20) and an auto-width child.
        // The fixed child's right edge sits at content_right - margin_right, so x = 300 - 100 - 20 = 180; the
        // auto-width child FILLS the width and lands back at content_left (x = 0), exercising the shared formula.
        let mut root = blk(0.0, -1);
        root.rtl = 1;
        let mut a = blk(1.0, 0);
        a.width = 100.0;
        a.height = 20.0;
        a.mr = 20.0;
        let mut b = blk(2.0, 0);
        b.height = 10.0; // auto width → fills 300
        let inputs = vec![root, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 300.0));
        assert_eq!([bx[1].x, bx[1].w], [180.0, 100.0]); // fixed child at the right, inset by its right margin
        assert_eq!([bx[2].x, bx[2].w], [0.0, 300.0]);   // auto-width child fills and sits at content-left
    }

    #[test]
    fn border_box_size_is_floored_at_its_edges() {
        // box-sizing:border-box with border+padding LARGER than the declared size: the content box can't go
        // below 0, so the border box is max(declared, edges) — width 100 vs edges 30 → 100; height 20 vs edges
        // 30 → 30 (Chrome / the oracle grow it, native used to keep the too-small 20).
        let mut a = blk(1.0, 0);
        a.border_box = true;
        a.width = 100.0;
        a.height = 20.0;
        a.bt = 10.0; a.br = 10.0; a.bb = 10.0; a.bl = 10.0; // border 10 each side → edges 20
        a.pt = 5.0; a.pr = 5.0; a.pb = 5.0; a.pl = 5.0;     // padding 5 each side → +10 → edges_y = 30
        a.height_adjoins = false;
        let inputs = vec![blk(0.0, -1), a];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].w, bx[1].h], [100.0, 30.0]); // width keeps 100 (> edges 30); height floored to 30
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
    fn bfc_owner_contains_a_left_float() {
        // root > owner(overflow:hidden, auto height) > float(left, 80x120). The owner OWNS the float
        // context, so its auto height grows to contain the float (clearfix); the float sits at the
        // owner's content top-left and does not advance the flow.
        let mut owner = blk(1.0, 0);
        owner.starts_bfc = true;
        let mut f = blk(2.0, 1);
        f.float_kind = FLOAT_LEFT;
        f.width = 80.0;
        f.height = 120.0;
        f.height_adjoins = false;
        let inputs = vec![blk(0.0, -1), owner, f];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].h, 120.0); // owner contains the float
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 0.0, w: 80.0, h: 120.0, auto_height: false });
    }

    #[test]
    fn two_left_floats_second_drops_when_it_does_not_fit() {
        // owner content width 200; two left floats 120 wide each — the second cannot sit beside the first
        // (240 > 200), so it drops below it (§9.5.1 rule 3).
        let mut owner = blk(1.0, 0);
        owner.starts_bfc = true;
        owner.width = 200.0;
        owner.height_adjoins = false;
        let mut a = blk(2.0, 1);
        a.float_kind = FLOAT_LEFT;
        a.width = 120.0;
        a.height = 40.0;
        a.height_adjoins = false;
        let mut b = blk(3.0, 1);
        b.float_kind = FLOAT_LEFT;
        b.width = 120.0;
        b.height = 30.0;
        b.height_adjoins = false;
        let inputs = vec![blk(0.0, -1), owner, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[2].y, 0.0); // first float at the top
        assert_eq!(bx[3].y, 40.0); // second drops below the first
        assert_eq!(bx[3].x, 0.0); // …back at the left edge
        assert_eq!(bx[1].h, 70.0); // owner contains both (40 + 30)
    }

    fn flex(nid: f64, parent: i32, width: f64) -> Input {
        let mut c = blk(nid, parent);
        c.display = DISPLAY_FLEX;
        c.border_box = true;
        c.width = width;
        c
    }
    fn item(nid: f64, parent: i32, w: f64, h: f64) -> Input {
        let mut c = blk(nid, parent);
        c.border_box = true; // the pushed used size is a border box
        c.width = w;
        c.height = h;
        c.height_adjoins = false;
        c
    }

    #[test]
    fn flex_row_justify_content() {
        // 600px row, three 100px items — every justify-content value's main-axis offsets.
        let cases: [(u8, [f64; 3]); 6] = [
            (0, [0.0, 100.0, 200.0]),   // start
            (1, [150.0, 250.0, 350.0]), // center
            (2, [300.0, 400.0, 500.0]), // end
            (3, [0.0, 250.0, 500.0]),   // space-between
            (4, [50.0, 250.0, 450.0]),  // space-around
            (5, [75.0, 250.0, 425.0]),  // space-evenly
        ];
        for (code, xs) in cases {
            let mut f = flex(0.0, -1, 600.0);
            f.flex_justify = code;
            let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
            let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
            assert_eq!([bx[1].x, bx[2].x, bx[3].x], xs, "justify code {code}");
        }
    }

    #[test]
    fn flex_row_gap_and_margins() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_gap = 20.0;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 120.0, 240.0]); // 100 + 20 gap

        // A left margin on the middle item pushes it (and the run after) right.
        let mut m = item(2.0, 0, 100.0, 30.0);
        m.ml = 15.0;
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), m, item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 115.0, 215.0]);
    }

    #[test]
    fn flex_row_cross_align() {
        // 90px-tall row, a 30px item — align-items start / center / end.
        for (code, y) in [(0u8, 0.0), (1u8, 30.0), (2u8, 60.0)] {
            let mut f = flex(0.0, -1, 600.0);
            f.height = 90.0;
            f.height_adjoins = false;
            let mut a = item(1.0, 0, 100.0, 30.0);
            a.flex_cross_align = code;
            let inputs = vec![f, a];
            let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
            assert_eq!(bx[1].y, y, "align code {code}");
            assert_eq!(bx[0].h, 90.0);
        }
    }

    #[test]
    fn flex_row_baseline_aligns_items_on_a_shared_baseline() {
        // Two baseline items: a (outer 37, asc 29) and b (outer 18, asc 14). They hang from the deepest
        // ascent (firstAsc=29): a at y=0, b at y=29-14=15. Line cross = 29 + max(37-29, 18-14) = 37.
        let f = flex(0.0, -1, 400.0);
        let mut a = item(1.0, 0, 39.0, 37.0);
        a.flex_cross_align = CROSS_BASELINE;
        a.flex_baseline_asc = 29.0;
        let mut b = item(2.0, 0, 16.0, 18.0);
        b.flex_cross_align = CROSS_BASELINE;
        b.flex_baseline_asc = 14.0;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y], [0.0, 15.0]);
        assert_eq!(bx[0].h, 37.0); // auto height = the baseline group's extent
    }

    #[test]
    fn flex_out_of_flow_child_placed_at_its_pushed_offset() {
        // An abspos child (out_of_flow) is placed at the container origin + its resolved displacement
        // (rel_x/rel_y — insets or the static position), while the in-flow item is placed normally.
        let f = flex(0.0, -1, 300.0);
        let a = item(1.0, 0, 50.0, 20.0);
        let mut abs = item(2.0, 0, 40.0, 30.0);
        abs.out_of_flow = 1;
        abs.rel_x = 20.0;
        abs.rel_y = 10.0;
        let inputs = vec![f, a, abs];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[1].y], [0.0, 0.0]); // in-flow item at the start
        assert_eq!([bx[2].x, bx[2].y], [20.0, 10.0]); // abspos at origin + (20,10)
    }

    #[test]
    fn flex_out_of_flow_child_excluded_from_sizing_and_justify() {
        // Auto-height row, justify center: the 99px-tall abspos child neither grows the container nor takes
        // main free space — the height is the in-flow item's cross, and center uses only the in-flow width.
        let mut f = flex(0.0, -1, 300.0);
        f.flex_justify = 1;
        let a = item(1.0, 0, 50.0, 20.0);
        let mut abs = item(2.0, 0, 40.0, 99.0);
        abs.out_of_flow = 1;
        let inputs = vec![f, a, abs];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 20.0); // auto height = in-flow cross, not the 99px abspos
        assert_eq!(bx[1].x, 125.0); // center: (300-50)/2, abspos not in the free space
    }

    #[test]
    fn flex_row_baseline_group_extent_counts_the_deepest_ascent() {
        // A text item (outer 37, asc 29) beside a text-less box whose synthesised baseline is its bottom edge
        // (outer 60, asc 60). firstAsc=60, firstBelow=max(37-29, 60-60)=8 → line cross 68; text at 60-29=31,
        // box at 60-60=0.
        let f = flex(0.0, -1, 400.0);
        let mut t = item(1.0, 0, 39.0, 37.0);
        t.flex_cross_align = CROSS_BASELINE;
        t.flex_baseline_asc = 29.0;
        let mut bx2 = item(2.0, 0, 40.0, 60.0);
        bx2.flex_cross_align = CROSS_BASELINE;
        bx2.flex_baseline_asc = 60.0;
        let inputs = vec![f, t, bx2];
        let b = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([b[1].y, b[2].y], [31.0, 0.0]);
        assert_eq!(b[0].h, 68.0);
    }

    #[test]
    fn flex_row_last_baseline_anchors_the_group_at_the_cross_end() {
        // 80px row, two last-baseline items: a (outer 37, last-asc 29), b (outer 18, last-asc 14). lastExtent
        // = 29 + max(37-29, 18-14) = 37; the group sits at the cross-END (80-37=43): a at 43, b at 43+29-14=58.
        let mut f = flex(0.0, -1, 400.0);
        f.height = 80.0;
        f.height_adjoins = false;
        let mut a = item(1.0, 0, 39.0, 37.0);
        a.flex_cross_align = CROSS_BASELINE_LAST;
        a.flex_baseline_asc = 29.0;
        let mut b = item(2.0, 0, 16.0, 18.0);
        b.flex_cross_align = CROSS_BASELINE_LAST;
        b.flex_baseline_asc = 14.0;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y], [43.0, 58.0]);
    }

    #[test]
    fn flex_row_first_and_last_baseline_groups_coexist() {
        // 80px row: a first-baseline item (asc 29) hangs at the cross-START (y=0); a last-baseline item (asc
        // 14, lastExtent 14+4=18) hangs at the cross-END (80-18=62, +14-14 → 62).
        let mut f = flex(0.0, -1, 400.0);
        f.height = 80.0;
        f.height_adjoins = false;
        let mut a = item(1.0, 0, 39.0, 37.0);
        a.flex_cross_align = CROSS_BASELINE;
        a.flex_baseline_asc = 29.0;
        let mut b = item(2.0, 0, 16.0, 18.0);
        b.flex_cross_align = CROSS_BASELINE_LAST;
        b.flex_baseline_asc = 14.0;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y], [0.0, 62.0]);
    }

    fn flex_col(nid: f64, parent: i32, width: f64) -> Input {
        let mut c = flex(nid, parent, width);
        c.flex_main_is_x = false;
        c
    }

    #[test]
    fn flex_row_auto_left_margin_pushes_item_and_rest_right() {
        // [a, b(margin-left:auto), c] in 600px: the one auto margin absorbs all 300 free space, so a stays
        // left and b/c are pushed right; justify-content yields.
        let f = flex(0.0, -1, 600.0);
        let mut b = item(2.0, 0, 100.0, 30.0);
        b.flex_item_auto = 1; // main-start-side (left) margin is auto
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), b, item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 400.0, 500.0]);
    }

    #[test]
    fn flex_row_two_auto_margins_split_the_free_space() {
        // a(margin-right:auto) and b(margin-left:auto) → 2 autos share 400 free (200 each): a at 0,
        // b at 100 + 200 + 200 = ... a:0, gap to b = a.mr-auto(200) + b.ml-auto(200).
        let mut a = item(1.0, 0, 100.0, 30.0);
        a.flex_item_auto = 2; // main-end-side (right) auto
        let mut b = item(2.0, 0, 100.0, 30.0);
        b.flex_item_auto = 1; // main-start-side (left) auto
        let inputs = vec![flex(0.0, -1, 600.0), a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        // free = 600 - 200 = 400, each = 200. a at 0; after a: +100 +200(a.mr) → 300; b.ml auto +200 → 500.
        assert_eq!([bx[1].x, bx[2].x], [0.0, 500.0]);
    }

    #[test]
    fn flex_row_cross_auto_margins_place_on_the_cross_axis() {
        // 90px-tall row, one 30px item. A cross `auto` margin eats the line's leftover and wins over
        // align-items. Bits are cross-start=top(4) / cross-end=bottom(8): both centre (y=30), top-only
        // pushes to the bottom (y=60), bottom-only keeps it flush at the top (y=0).
        for (bits, y) in [(12u8, 30.0), (4u8, 60.0), (8u8, 0.0)] {
            let mut f = flex(0.0, -1, 600.0);
            f.height = 90.0;
            f.height_adjoins = false;
            let mut a = item(1.0, 0, 100.0, 30.0);
            a.flex_item_auto = bits;
            let inputs = vec![f, a];
            let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
            assert_eq!(bx[1].y, y, "cross-auto bits {bits}");
        }
    }

    #[test]
    fn flex_column_cross_auto_margin_centers_on_x() {
        // A column's cross axis is X: margin-left:auto + margin-right:auto (bits 4|8) centres the 50px
        // item in the 200px width → x=75, the same split as align-items:center but via the margins.
        let mut a = item(1.0, 0, 50.0, 30.0);
        a.flex_item_auto = 12;
        let inputs = vec![flex_col(0.0, -1, 200.0), a];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].x, 75.0); // (200 - 50) / 2
    }

    #[test]
    fn flex_row_min_height_grows_the_box_below_content_aligned_items() {
        // Auto-height row of a 30px + a 50px item: the content cross is 50, so align-items:center centres
        // each item in 50 (the 30px one at y=10, the 50px one at y=0). min-height:100 then grows the BOX to
        // 100 WITHOUT repositioning the items (two-phase — the clamp lands after flex layout).
        let mut f = flex(0.0, -1, 600.0);
        f.min_h = 100.0;
        let mut a = item(1.0, 0, 80.0, 30.0);
        a.flex_cross_align = 1;
        let mut b = item(2.0, 0, 80.0, 50.0);
        b.flex_cross_align = 1;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 100.0); // box grown by min-height
        assert_eq!(bx[1].y, 10.0);  // 30px item centred in the 50px content line
        assert_eq!(bx[2].y, 0.0);   // 50px item fills the content line
    }

    #[test]
    fn flex_row_max_height_shrinks_the_box_but_the_content_line_overflows() {
        // max-height:20 caps the container box at 20, but a 30px item's line is taller than the cap, so the
        // line stays 30 (the item overflows downward) and a centred item sits at y=0 — the box is 20 tall.
        let mut f = flex(0.0, -1, 600.0);
        f.max_h = 20.0;
        let mut a = item(1.0, 0, 100.0, 30.0);
        a.flex_cross_align = 1; // center, but the line equals the item so there is no slack
        let inputs = vec![f, a];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 20.0);
        assert_eq!(bx[1].y, 0.0);
    }

    #[test]
    fn flex_column_stacks_items_and_auto_height_sums_them() {
        let inputs = vec![flex_col(0.0, -1, 200.0), item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0), item(3.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [0.0, 30.0, 60.0]); // stacked down the main (Y) axis
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 0.0, 0.0]);   // cross-start on X
        assert_eq!(bx[0].h, 90.0); // auto main = Σ item heights
        assert_eq!(bx[0].w, 200.0);
    }

    #[test]
    fn flex_column_justify_center_with_definite_height() {
        let mut f = flex_col(0.0, -1, 200.0);
        f.height = 200.0;
        f.height_adjoins = false;
        f.flex_justify = 1; // center
        let inputs = vec![f, item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0), item(3.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        // free = 200 - 90 = 110; center lead = 55 → y 55 / 85 / 115.
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [55.0, 85.0, 115.0]);
        assert_eq!(bx[0].h, 200.0);
    }

    #[test]
    fn flex_column_cross_align_center_on_x() {
        let mut a = item(1.0, 0, 50.0, 30.0);
        a.flex_cross_align = 1; // center on the cross (X) axis
        let inputs = vec![flex_col(0.0, -1, 200.0), a];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].x, 75.0); // (200 - 50) / 2
    }

    #[test]
    fn flex_column_min_height_floors_the_extent_and_justify_distributes() {
        // Auto-height column, two 30px items (content 60). min-height:200 floors the extent to 200 — a main
        // size justify-content distributes (§page-shell min-h-screen) — and grows the box to 200.
        let mut f = flex_col(0.0, -1, 100.0);
        f.min_h = 200.0;
        f.flex_justify = 1; // center
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 200.0);
        assert_eq!([bx[1].y, bx[2].y], [70.0, 100.0]); // free = 200-60 = 140, center lead 70
    }

    #[test]
    fn flex_column_max_height_caps_the_box_while_content_overflows() {
        // Auto-height column, three non-shrinking 30px items (content 90). max-height:40 caps the BOX at 40,
        // but the items (pushed at their own size) overflow it — extent = capacity, justify free negative.
        let mut f = flex_col(0.0, -1, 100.0);
        f.max_h = 40.0;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 40.0); // box capped by max-height
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [0.0, 30.0, 60.0]); // items overflow (free = 40 - 90 < 0)
    }

    #[test]
    fn flex_column_declared_height_clamped_up_by_min_height() {
        // A DECLARED height is clamped by min/max-height before layout (definite), so items justify in the
        // clamped extent: height:40 clamped up to min-height:90, justify-end puts the 30px item at y=60.
        let mut f = flex_col(0.0, -1, 100.0);
        f.height = 40.0;
        f.height_adjoins = false;
        f.min_h = 90.0;
        f.flex_justify = 2; // end
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 90.0);
        assert_eq!(bx[1].y, 60.0); // extent 90, free 60, end
    }

    #[test]
    fn flex_row_reverse_places_from_the_right() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_reverse = true;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [500.0, 400.0, 300.0]); // first item rightmost, packed at the right
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [0.0, 0.0, 0.0]);       // cross still forward
    }

    #[test]
    fn flex_column_reverse_places_from_the_bottom() {
        let mut f = flex_col(0.0, -1, 200.0);
        f.flex_main_reverse = true;
        f.height = 200.0;
        f.height_adjoins = false;
        let inputs = vec![f, item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y], [170.0, 140.0]); // first item at the bottom (200-30), packed at main-start
        assert_eq!([bx[1].x, bx[2].x], [0.0, 0.0]);
    }

    #[test]
    fn flex_row_reverse_leading_margin_is_the_right_margin() {
        // main-start is the right edge, so the leading margin is margin-right.
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_reverse = true;
        let mut a = item(1.0, 0, 100.0, 30.0);
        a.mr = 20.0; // leading margin on a reversed row
        let inputs = vec![f, a, item(2.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        // item a: abstract at = 0 + lead(mr 20) = 20, size 100 → main_phys = 600 - 20 - 100 = 480.
        assert_eq!(bx[1].x, 480.0);
        // item 2: abstract at advances by a's outer (20+100) then its own lead(0) → 120; phys = 600-120-100=380.
        assert_eq!(bx[2].x, 380.0);
    }

    #[test]
    fn flex_row_wrap_breaks_lines_and_auto_height_stacks_them() {
        // width 250, three 100px items → [item0,item1] then [item2]; auto height = two 30px lines.
        let mut f = flex(0.0, -1, 250.0);
        f.flex_wrap = true;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!((bx[1].x, bx[1].y), (0.0, 0.0));
        assert_eq!((bx[2].x, bx[2].y), (100.0, 0.0)); // second item fits on line 0
        assert_eq!((bx[3].x, bx[3].y), (0.0, 30.0));  // third wraps to line 1
        assert_eq!(bx[0].h, 60.0);                     // two stacked lines
    }

    #[test]
    fn flex_row_wrap_align_content_center_at_definite_height() {
        // two lines (cross 30 each, sum 60) in a 200px-tall container → free 140, center lead 70.
        let mut f = flex(0.0, -1, 250.0);
        f.flex_wrap = true;
        f.height = 200.0;
        f.height_adjoins = false;
        f.flex_align_content = 1; // center
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].y, 70.0); // line 0 at the centred stack start
        assert_eq!(bx[3].y, 100.0); // line 1 = 70 + 30
        assert_eq!(bx[0].h, 200.0);
    }

    #[test]
    fn flex_row_wrap_cross_gap_between_lines() {
        let mut f = flex(0.0, -1, 250.0);
        f.flex_wrap = true;
        f.flex_cross_gap = 10.0;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[3].y, 40.0); // 30 (line 0) + 10 (cross gap)
        assert_eq!(bx[0].h, 70.0); // 30 + 10 + 30
    }

    #[test]
    fn flex_row_auto_height_wraps_the_tallest_item() {
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 50.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 50.0); // auto height = tallest item outer
        assert!(bx[0].auto_height);
    }

    #[test]
    fn unsupported_subtree_declines() {
        let mut a = blk(1.0, 0);
        a.display = DISPLAY_UNSUPPORTED; // e.g. flex
        let inputs = vec![blk(0.0, -1), a];
        assert!(matches!(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
    }

    fn tbl(nid: f64, parent: i32, sx: f64, sy: f64) -> Input {
        let mut c = blk(nid, parent);
        c.display = DISPLAY_TABLE;
        c.sp_x = sx;
        c.sp_y = sy;
        c
    }
    fn rowgroup(nid: f64, parent: i32) -> Input {
        let mut c = blk(nid, parent);
        c.display = DISPLAY_TABLE_ROW_GROUP;
        c
    }
    fn rowel(nid: f64, parent: i32) -> Input {
        let mut c = blk(nid, parent);
        c.display = DISPLAY_TABLE_ROW;
        c
    }
    fn cell(nid: f64, parent: i32, w: f64, h: f64, col: usize, colspan: usize, rowspan: usize) -> Input {
        let mut c = item(nid, parent, w, h);
        c.cell_col = col;
        c.cell_colspan = colspan;
        c.cell_rowspan = rowspan;
        c
    }

    #[test]
    fn table_2x2_grouped_positions_cells_by_prefix_sums() {
        // The probed 2x2 table: border-spacing 4, columns 62/82, rows 32/42. Cells placed by prefix sums;
        // rows/row-group/table boxes all derived; table self-sizes (ignores the 800 passed width).
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table
            rowgroup(1.0, 0),                  // 1 tbody
            rowel(2.0, 1),                     // 2 tr0
            cell(3.0, 2, 62.0, 32.0, 0, 1, 1), // 3 td(0,0)
            cell(4.0, 2, 82.0, 32.0, 1, 1, 1), // 4 td(0,1)
            rowel(5.0, 1),                     // 5 tr1
            cell(6.0, 5, 62.0, 42.0, 0, 1, 1), // 6 td(1,0)
            cell(7.0, 5, 82.0, 42.0, 1, 1, 1), // 7 td(1,1)
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].x, bx[0].y, bx[0].w, bx[0].h], [0.0, 0.0, 156.0, 86.0]); // table
        assert_eq!([bx[1].x, bx[1].y, bx[1].w, bx[1].h], [4.0, 4.0, 148.0, 78.0]); // tbody
        assert_eq!([bx[2].x, bx[2].y, bx[2].w, bx[2].h], [4.0, 4.0, 148.0, 32.0]); // tr0
        assert_eq!([bx[3].x, bx[3].y], [4.0, 4.0]); // td(0,0)
        assert_eq!([bx[4].x, bx[4].y], [70.0, 4.0]); // td(0,1) = 4 + 62 + 4
        assert_eq!([bx[5].x, bx[5].y, bx[5].h], [4.0, 40.0, 42.0]); // tr1 = 4 + 32 + 4
        assert_eq!([bx[6].x, bx[6].y], [4.0, 40.0]); // td(1,0)
        assert_eq!([bx[7].x, bx[7].y], [70.0, 40.0]); // td(1,1)
    }

    #[test]
    fn table_bare_rows_parent_is_the_table() {
        // A display:table with bare rows (no row group): each row's parent is the table itself.
        let inputs = vec![
            tbl(0.0, -1, 3.0, 3.0),            // 0 table
            rowel(1.0, 0),                     // 1 tr (parent = table)
            cell(2.0, 1, 40.0, 20.0, 0, 1, 1), // 2 td
            cell(3.0, 1, 60.0, 20.0, 1, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [109.0, 26.0]); // 40+60 + 3*3 ; 20 + 2*3
        assert_eq!([bx[1].x, bx[1].y], [3.0, 3.0]); // row at (sx, sy)
        assert_eq!([bx[2].x, bx[2].y], [3.0, 3.0]); // td0
        assert_eq!([bx[3].x, bx[3].y], [46.0, 3.0]); // td1 = 3 + 40 + 3
    }

    #[test]
    fn table_ragged_grid_lays_out_present_cells() {
        // A ragged grid (row 1 missing its col-1 cell) is fine once cells carry their own column: the present
        // cells sit at their columns, and the absent slot simply has no box — matching the oracle.
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),
            rowel(1.0, 0),
            cell(2.0, 1, 40.0, 20.0, 0, 1, 1),
            cell(3.0, 1, 50.0, 20.0, 1, 1, 1),
            rowel(4.0, 0),
            cell(5.0, 4, 40.0, 20.0, 0, 1, 1), // row 1 has only col 0
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 102.0); // 4+40+4+50+4 (2 columns)
        assert_eq!([bx[2].x, bx[3].x], [4.0, 48.0]); // row 0 cols
        assert_eq!([bx[5].x, bx[5].y], [4.0, 28.0]); // row 1 col 0
    }

    #[test]
    fn table_colspan_cell_spans_columns() {
        // t2: a colspan=2 cell (cols 0-1) over a 3-column table; its width = colW[0] + sx + colW[1]. Columns
        // (32/42/52) come from the full second row; the spanning cell sits at col_x[0].
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table
            rowgroup(1.0, 0),                  // 1
            rowel(2.0, 1),                     // 2 tr0
            cell(3.0, 2, 78.0, 22.0, 0, 2, 1), // 3 colspan=2 (cols 0-1), 32+4+42
            cell(4.0, 2, 52.0, 22.0, 2, 1, 1), // 4 col 2
            rowel(5.0, 1),                     // 5 tr1
            cell(6.0, 5, 32.0, 20.0, 0, 1, 1), // 6 col 0
            cell(7.0, 5, 42.0, 20.0, 1, 1, 1), // 7 col 1
            cell(8.0, 5, 52.0, 20.0, 2, 1, 1), // 8 col 2
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [142.0, 54.0]); // 4+32+4+42+4+52+4 ; 4+22+4+20+4
        assert_eq!([bx[3].x, bx[3].y, bx[3].w], [4.0, 4.0, 78.0]); // the colspan cell at col 0
        assert_eq!([bx[4].x, bx[4].y], [86.0, 4.0]); // col 2
        assert_eq!([bx[6].x, bx[7].x, bx[8].x], [4.0, 40.0, 86.0]); // tr1 columns
    }

    #[test]
    fn table_rowspan_cell_spans_rows() {
        // t2: a rowspan=2 cell (col 0) in a 2-column, 2-row table; its height = rowH[0] + sy + rowH[1]. Row 1
        // has only the col-1 cell (col 0 occupied by the span), so that cell's pushed col is 1, not 0.
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table
            rowgroup(1.0, 0),                  // 1
            rowel(2.0, 1),                     // 2 tr0
            cell(3.0, 2, 32.0, 63.0, 0, 1, 2), // 3 rowspan=2 (col 0), 22+4+37
            cell(4.0, 2, 52.0, 22.0, 1, 1, 1), // 4 col 1, row 0
            rowel(5.0, 1),                     // 5 tr1
            cell(6.0, 5, 52.0, 37.0, 1, 1, 1), // 6 col 1, row 1
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [96.0, 71.0]); // 4+32+4+52+4 ; 4+22+4+37+4
        assert_eq!([bx[3].x, bx[3].y, bx[3].h], [4.0, 4.0, 63.0]); // the rowspan cell
        assert_eq!([bx[4].x, bx[4].y], [40.0, 4.0]); // col 1 row 0
        assert_eq!([bx[6].x, bx[6].y], [40.0, 30.0]); // col 1 row 1 (pushed col = 1)
    }

    #[test]
    fn table_collapse_frame_is_the_tables_own_outer_half_border() {
        // border-collapse: spacing 0, and the oracle resolves the whole collapsed-border model up front — it
        // pushes each cell's border box already carrying its halved borders (col widths 46/56, rows 26/36) and
        // the TABLE's own border as the outer half of its rim cells' borders (2 on every side). So native needs
        // no frame of its own: it self-sizes from Σtracks + its edges, placing the grid inside that border,
        // exactly as for a separate table.
        let mut t = tbl(0.0, -1, 0.0, 0.0);
        t.bt = 2.0;
        t.br = 2.0;
        t.bb = 2.0;
        t.bl = 2.0;
        let inputs = vec![
            t,                          // 0 table (collapse); its border IS the outer half-frame
            rowgroup(1.0, 0),           // 1
            rowel(2.0, 1),              // 2
            cell(3.0, 2, 46.0, 26.0, 0, 1, 1), // 3
            cell(4.0, 2, 56.0, 26.0, 1, 1, 1), // 4
            rowel(5.0, 1),              // 5
            cell(6.0, 5, 46.0, 36.0, 0, 1, 1), // 6
            cell(7.0, 5, 56.0, 36.0, 1, 1, 1), // 7
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [106.0, 66.0]); // Σtracks (102 / 62) + the table's own edges (2 each side)
        assert_eq!([bx[3].x, bx[3].y], [2.0, 2.0]); // content origin = the table border (no padding, no spacing)
        assert_eq!(bx[4].x, 48.0); // 2 + 46 (cells meet, no spacing)
        assert_eq!(bx[6].y, 28.0); // 2 + 26
    }

    #[test]
    fn table_column_only_spanned_declines() {
        // col 1 is covered only by spans (row0 cols 0-1, row1 cols 1-2) — no colspan==1 cell gives its width,
        // so native can't split the track → decline.
        let inputs = vec![
            tbl(0.0, -1, 0.0, 0.0),
            rowgroup(1.0, 0),
            rowel(2.0, 1),
            cell(3.0, 2, 50.0, 20.0, 0, 2, 1), // cols 0-1
            cell(4.0, 2, 20.0, 20.0, 2, 1, 1), // col 2
            rowel(5.0, 1),
            cell(6.0, 5, 30.0, 20.0, 0, 1, 1), // col 0
            cell(7.0, 5, 40.0, 20.0, 1, 2, 1), // cols 1-2 → col 1 never a single cell
        ];
        assert!(matches!(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
    }

    // t4 — the caption (a block box, the table's only non-row/-group child). The `<table>` box is the WRAPPER:
    // a top caption offsets the whole grid down by its own height; a bottom one sits below the grid; the wrapper
    // width unions the grid with a wider caption. The caption here is `item()` (a pushed fixed border box), a
    // plain block child of the table — measure_table finds it structurally, not by a display code.
    #[test]
    fn table_caption_top_offsets_the_grid_down() {
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table (wrapper); caption_side top (0 = default)
            item(1.0, 0, 100.0, 16.0),         // 1 caption (block, pushed 100x16)
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3 td col 0
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4 td col 1
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        // wrapper: width = grid (60+80 + 3*4 = 152) ; height = grid (20 + 2*4 = 28) + caption 16 = 44
        assert_eq!([bx[0].w, bx[0].h], [152.0, 44.0]);
        assert_eq!([bx[1].x, bx[1].y, bx[1].w, bx[1].h], [0.0, 0.0, 100.0, 16.0]); // caption at the top
        assert_eq!([bx[3].x, bx[3].y], [4.0, 20.0]); // td col 0: grid offset DOWN by caption (16) + sy (4)
        assert_eq!([bx[4].x, bx[4].y], [68.0, 20.0]); // td col 1 = 4 + 60 + 4
    }

    #[test]
    fn table_caption_bottom_sits_below_the_grid() {
        let mut t = tbl(0.0, -1, 4.0, 4.0);
        t.caption_side = 1; // bottom
        let inputs = vec![
            t,                                 // 0 table (wrapper)
            item(1.0, 0, 100.0, 16.0),         // 1 caption
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [152.0, 44.0]); // same wrapper size
        assert_eq!([bx[3].x, bx[3].y], [4.0, 4.0]); // grid NOT offset — cells at the top
        assert_eq!([bx[4].x, bx[4].y], [68.0, 4.0]);
        assert_eq!([bx[1].x, bx[1].y], [0.0, 28.0]); // caption below the grid (grid_h = 28)
    }

    #[test]
    fn table_caption_wider_than_grid_widens_the_wrapper() {
        let t = tbl(0.0, -1, 4.0, 4.0);
        let inputs = vec![
            t,                                 // 0 table
            item(1.0, 0, 300.0, 16.0),         // 1 caption, wider than the 152 grid
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 300.0); // wrapper widened to the caption
        assert_eq!(bx[0].h, 44.0);
        // the grid keeps its own width — cells are NOT stretched to the caption
        assert_eq!([bx[3].x, bx[4].x], [4.0, 68.0]);
    }

    // A caption on a table with its OWN border sits at the WRAPPER's border box — outside the border, not inset
    // into the content box: x=0 / y=0 at the top-left, the full border-box width (the oracle pushes it), and the
    // grid is offset DOWN past the caption and then IN by the border. (§17.4 wrapper box.)
    #[test]
    fn table_caption_spans_the_border_box_outside_the_border() {
        let mut t = tbl(0.0, -1, 0.0, 0.0);
        t.bl = 10.0;
        t.br = 10.0;
        t.bt = 10.0;
        t.bb = 10.0;
        let inputs = vec![
            t,                                 // 0 table (border 10, no spacing)
            item(1.0, 0, 60.0, 16.0),          // 1 caption, pushed at the border box (40 cell + 2*10)
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 40.0, 20.0, 0, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        // wrapper: width = grid border box (40 + 2*10) unioned with the caption (60) = 60 ; height = grid 20 +
        // caption 16 + edges 20 = 56
        assert_eq!([bx[0].w, bx[0].h], [60.0, 56.0]);
        assert_eq!([bx[1].x, bx[1].y, bx[1].w, bx[1].h], [0.0, 0.0, 60.0, 16.0]); // caption OUTSIDE the border
        assert_eq!([bx[3].x, bx[3].y], [10.0, 26.0]); // grid: border-left in, down past caption(16) + border(10)
    }

    // A bottom caption on a bordered table sits just BELOW the table's bottom border, not inside it.
    #[test]
    fn table_caption_bottom_clears_the_border() {
        let mut t = tbl(0.0, -1, 0.0, 0.0);
        t.bl = 10.0;
        t.br = 10.0;
        t.bt = 10.0;
        t.bb = 10.0;
        t.caption_side = 1; // bottom
        let inputs = vec![
            t,
            item(1.0, 0, 60.0, 16.0),          // 1 caption
            rowel(2.0, 0),
            cell(3.0, 2, 40.0, 20.0, 0, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[3].x, bx[3].y], [10.0, 10.0]); // grid at the top, inside the border (no top caption)
        assert_eq!([bx[1].x, bx[1].y], [0.0, 40.0]); // caption below the bottom border: bt(10)+grid_h(20)+bb(10)
    }

    // A wide caption on a bordered table floors the wrapper to the caption's border box — it does NOT add the
    // table border on TOP of it (the over-grow this revision fixed): caption 300 → wrapper 300, not 320. The
    // oracle floors the content box to 280 (300 - the two borders) and pushes the cell at that width.
    #[test]
    fn table_caption_wider_than_a_bordered_grid_does_not_re_add_the_border() {
        let mut t = tbl(0.0, -1, 0.0, 0.0);
        t.bl = 10.0;
        t.br = 10.0;
        t.bt = 10.0;
        t.bb = 10.0;
        let inputs = vec![
            t,
            item(1.0, 0, 300.0, 16.0),          // 1 caption, spans the border box the oracle grew to 300
            rowel(2.0, 0),
            cell(3.0, 2, 280.0, 20.0, 0, 1, 1), // 3 td filling the floored content box (300 - 2*10)
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 300.0); // NOT 320 — the caption border box IS the wrapper, the border is not re-added
        assert_eq!([bx[1].x, bx[1].w], [0.0, 300.0]);
        assert_eq!([bx[3].x, bx[3].w], [10.0, 280.0]);
    }
}
