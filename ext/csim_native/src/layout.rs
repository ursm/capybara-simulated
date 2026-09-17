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

use std::cell::Cell;

// Sentinels in the input record: a used value that is `auto` / `none` arrives as f64::NAN (JS writes
// NaN for auto width/height/margin and for absent min/max), distinguished from a real 0.
fn is_auto(v: f64) -> bool {
    v.is_nan()
}
// An `imposed_h` that asks `measure` for a box's content height, its declared height set aside — see
// `Input::with_imposed_height`. (A negative-infinite height is no height a layout could impose.)
// How much a line may exceed its band and still count as fitting (the oracle's `LINE_FIT_EPS`). The two
// engines add a line's widths in different orders — the oracle from the page origin, this one from the
// content edge — so a box whose content is EXACTLY its band wide lands on the comparison to the last bit and
// one ULP decides whether a line wraps. "Exactly fits" is the answer both should give.
const LINE_FIT_EPS: f64 = 1e-9;
const MEASURE_AUTO_HEIGHT: f64 = f64::NEG_INFINITY;

// Display codes JS writes into the buffer. `display:none` nodes are NOT pushed (no box). A block whose
// children are all block-level is DISPLAY_BLOCK; one whose content is pure text in a single font (an
// inline formatting context — stage L2) is DISPLAY_TEXT_BLOCK; anything else (inline elements,
// flex/grid/table, mixed block+text, …) is DISPLAY_UNSUPPORTED and the whole subtree falls back to JS.
pub(crate) const DISPLAY_BLOCK: u8 = 1;
pub(crate) const DISPLAY_TEXT_BLOCK: u8 = 2;
pub(crate) const DISPLAY_FLEX: u8 = 3;
// CSS Tables 3 (t1): the table box and its internal structure. Cells are ordinary block / text blocks
// (DISPLAY_BLOCK / DISPLAY_TEXT_BLOCK) laid out at the column width and row height the table computed for them.
pub(crate) const DISPLAY_TABLE: u8 = 4;
pub(crate) const DISPLAY_TABLE_ROW_GROUP: u8 = 5;
pub(crate) const DISPLAY_TABLE_ROW: u8 = 6;
// CSS Grid (§12), computed natively: the container's `grid_start` indexes the parallel `grids` buffer, which
// holds the parsed column template + gaps + row height + per-item placement. measure_grid sizes the columns
// (fixed / % / fr / intrinsic — measuring the items' min/max-content itself, `intrinsic_widths`) and lays out
// each item at its track width — rows are content-height or the declared `grid-auto-rows` (reproducing the
// coarse oracle). An out-of-flow item is replayed at its pushed box, as a block's abspos child is.
pub(crate) const DISPLAY_GRID: u8 = 7;
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
    // …and §8.3.1's BOTTOM rule, which is not the same question: it wants an AUTO height where the two above
    // want "auto or zero". A `height: 0` block collapses THROUGH and still keeps its last child's bottom
    // margin in (Chrome: the block around it is 0 tall, not 12).
    pub(crate) bottom_adjoins: bool,
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
    // 1 left / 2 right; `clear` 0 none / 1 left / 2 right / 3 both. `starts_bfc` marks a block that
    // establishes a BLOCK FORMATTING CONTEXT — one flag because it is one property: no float crosses the
    // boundary in either direction, and its own margins do NOT collapse with its children's (§8.3.1).
    // For a floated box, its used width
    // rides `width` (JS resolves the shrink-to-fit; native computes the auto height from the subtree).
    pub(crate) float_kind: u8,
    pub(crate) clear: u8,
    // Whether that `clear` SEPARATES this box's top margin from its parent's (§8.3.1). Answered by the walk,
    // STRUCTURALLY — is there a float earlier in this box's formatting context — because the measure that
    // decides where a box goes cannot see the floats its ancestors inherited, and a box whose margin depends
    // on them would be placed differently by the two measures the float paths take.
    pub(crate) takes_clearance: bool,
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
    // Flex wrap: false = nowrap (one line, fills the cross), true = wrap or wrap-reverse (multi-line,
    // align-content stacks the lines). `flex_align_content` 0 flex-start / 1 center / 2 flex-end /
    // 3 space-between / 4 space-around / 5 space-evenly / 6 stretch / 7 start / 8 end — the last two kept
    // APART from 0 and 2 because they are flow-relative and only `align_content` knows which way the axis
    // runs. Stretch's GROW is already baked into the pushed item cross sizes, so native only positions the
    // lines (lead/between). `flex_cross_gap` is the px gap between lines.
    pub(crate) flex_wrap: bool,
    // `wrap-reverse`, which is NOT the same question as `flex_cross_far`: the wrap reversal is what the
    // flow-relative `start` / `end` follow, the physical direction is what every OFFSET is measured against,
    // and a `sideways-lr` container has one without the other.
    pub(crate) flex_cross_flip: bool,
    pub(crate) flex_align_content: u8,
    pub(crate) flex_cross_gap: f64,
    // Main axis reversed (row-reverse / column-reverse / rtl-row): the main axis runs from the FAR
    // physical edge back toward the near one. The abstract (main-start-relative) placement is unchanged;
    // only the final physical mapping mirrors, and the leading margin is the main-start-side one.
    pub(crate) flex_main_reverse: bool,
    // …and whether the CROSS axis runs from the far physical edge back (`plan.crossFar`). The in-flow items do
    // not need it — `crossAlignPhysical` has already flipped each item's align onto the physical axis — but an
    // OUT-OF-FLOW child's static position is measured ALONG the axis itself, so it does. It is its own input
    // rather than `rtl`: those two agreed only while every non-`horizontal-tb` container was declined, and a
    // `vertical-rl` row's cross runs right-to-left with no `rtl` in sight.
    //
    // It is set for a cross running BOTTOM→top as much as for one running right→left, and every reader pairs
    // it with the AXIS rather than assuming the horizontal one — `along` below is the shape of that. Five
    // readers, all in `measure_flex` and the out-of-flow static position: the order the lines stack in, where
    // the stack starts, a `stretch` line's far edge, which edge a baseline GROUP anchors at, and which margin
    // is the leading cross one.
    pub(crate) flex_cross_far: bool,
    // rec[65] bit 16: this text block has an out-of-flow child the walk REPLAYED (see `measure`).
    pub(crate) has_replayed_oof: bool,
    // `position: relative` offset (§9.4.3), resolved JS-side (relativeOffset). It moves the box and its
    // subtree at PAINT time without touching the flow, so `place` adds it after the absolute origin; the
    // flow (margin collapse, sibling positions, float bands) is computed from the unshifted position. A box's
    // own offset PLUS the accumulated offset of the relative inline boxes whose fragment it sits in — those
    // have no records of their own, so an atomic inline inside them carries their shift here. 0 where neither
    // it nor any inline above it is relative.
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
    // `direction: rtl` (r1): the box's own INLINE axis runs backwards. 0 = ltr. Which PHYSICAL edge that
    // inline-start is depends on the writing mode, so each consumer pairs this with the axis where the oracle
    // does: the block flow places children from the right edge only where the inline axis is the horizontal one
    // (`from_right`), while a TABLE mirrors its columns off `direction` ALONE (`measure_table`) — the oracle's
    // table path reads `flowSides(table).rtl` and mirrors horizontally, because it never runs a table sideways.
    // (Chrome reverses the columns down a vertical table's inline axis instead: the oracle's gap, not native's.)
    pub(crate) rtl: u8,
    // A text block's line alignment, PHYSICAL (the oracle's `textAlignOf` folds `start` / `end` through rtl):
    // 0 left, 1 right, 2 center. It moves a line's atomics (`line_layout`); `justify` never reaches native.
    pub(crate) text_align: u8,
    // A flex container's anonymous-item cross floor: the line-height of any bare (non-whitespace) text directly
    // inside it (0 when there is none). The oracle does not lay that text out as a real flex item, it only
    // floors the container's AUTO cross size at this line-height (`anonymousItemHeight`); native does the same.
    pub(crate) anon_cross: f64,
    // A text block's OWN `white-space` mode: 0 normal, 1 nowrap, 2 pre, 3 pre-wrap, 4 pre-line. The three
    // orthogonal behaviours it names — COLLAPSE whitespace (0/1/4) vs PRESERVE it (2/3), SOFT-WRAP at break
    // opportunities (0/3/4) vs never (1/2), a NEWLINE forcing a break (2/3/4) — belong to the RUN they are
    // about, so `line_layout` reads those off `Run::ws_mode`. What it still asks of the BLOCK is whether the
    // LINE may break at all (`outerWraps`: a non-wrapping RUN forbids breaks inside itself, the opportunity
    // before it is the block's to give), `pin` in `text_intrinsic` ("a box that never wraps has its
    // max-content for a min-content", which the oracle asks of the element), and the mode an empty block and
    // the anonymous groups are read under.
    pub(crate) ws_mode: u8,
    // A pushed flex ITEM whose OWN height is AUTO (content-derived), carried past the parent-push that
    // overwrote `height` with the item's final (oracle-clamped) box. When set, `measure_flex` recomputes a
    // ROW item's cross from its content and two-phases the min/max-height clamp (the items align in the
    // pre-clamp content, the box floors/caps around them), instead of aligning in the pushed definite box —
    // reproducing the oracle's auto-height two-phase for a nested min-height flex row (the Avo field-wrapper).
    pub(crate) item_auto_height: bool,
    // A PUSHED box's height (its final size written over the declared one) that was NOT definite when the container
    // resolved its percentages — a grid's row gap, a flex container's gaps and basis (`markPushedHeight`).
    pub(crate) pushed_h_indefinite: bool,
    // A grid container's offset into the parallel `grids` buffer (see measure_grid). Read only when
    // `display == DISPLAY_GRID`; 0 (unused) for every other node.
    pub(crate) grid_start: i32,
    // The DECLARED inline sizing with NO percentage basis — what an intrinsic measure reads (`intrinsic_widths`):
    // `width` / `min-width` / `max-width` as declared (a percentage is NaN = auto there, having nothing to
    // resolve against), the item's `flex-basis` (NaN = auto / content) and whether it may grow (`flex-grow` > 0),
    // and the declared `box-sizing`. Kept apart from `width` / `min_w` / `max_w` / `border_box`, which a flex /
    // out-of-flow / replay push overwrites with the USED box.
    pub(crate) decl_w: f64,
    pub(crate) decl_min_w: f64,
    pub(crate) decl_max_w: f64,
    pub(crate) flex_basis: f64,
    pub(crate) flex_grow: f64,
    pub(crate) decl_border_box: bool,
    // Flex SIZING inputs (an item of a natively-sized container, `flex_native`): `flex-shrink`; `flex-basis`
    // resolved against the container's main size (NaN = auto / a keyword — `flex_basis_kw` 0 none, 1 content,
    // 2 min-content, 3 max-content, 4 fit-content); whether the item scrolls across (its automatic minimum in
    // that axis is then zero, §4.5, and its baseline is clamped into its box); whether it STRETCHES in the
    // cross axis (`align-self: stretch` with an auto cross size and no auto cross margin). On a CONTAINER,
    // `flex_native` = the items' main sizes are computed here (`flex_row_sizes` / `flex_column_sizes`) rather
    // than pushed from the oracle.
    pub(crate) flex_shrink: f64,
    pub(crate) flex_basis_cb: f64,
    // A PERCENTAGE `flex-basis` as a fraction of the container's main size (NaN = none), resolved here
    // (`flex_basis_at`) — and a container's main / cross gap percentages, over the px parts in
    // `flex_main_gap` / `flex_cross_gap`. The walk used to resolve all three against the oracle's box.
    pub(crate) flex_basis_frac: f64,
    // The plain PERCENTAGES among width / height / min-width / max-width / min-height / max-height, as fractions
    // of the containing block (NaN = that size is a length or auto, already in its own field). The parent resolves
    // them when it lays this box out (`with_percent_sizes`), writing the result into those fields.
    pub(crate) pct_sizes: [f64; 6],
    // …and the margins' and padding's percentage parts (margin top / right / bottom / left, padding top / right /
    // bottom / left) as fractions of the containing-block WIDTH, 0 where there is none, beside the length parts the
    // walk sent (`edge_px`, kept apart from the fields a resolution overwrites).
    pub(crate) edge_frac: [f64; 8],
    pub(crate) edge_px: [f64; 8],
    // An out-of-flow box's inset percentages (top / right / bottom / left) as fractions of its containing block's
    // padding box — height for top / bottom, width for left / right — beside the length parts in `inset_*`.
    pub(crate) inset_frac: [f64; 4],
    pub(crate) flex_main_gap_frac: f64,
    pub(crate) flex_cross_gap_frac: f64,
    pub(crate) flex_basis_kw: u8,
    pub(crate) scrolls_x: bool,
    pub(crate) scrolls_y: bool,
    // A `<button>`: as wide as its CONTENT wants, whatever display it has and however much room it is given
    // (HTML's button layout IS shrink-to-fit — `block_child_width` routes an auto-width one through the
    // A `<button>`: as wide as its CONTENT wants, whatever display it has and however much room it is given
    // (HTML's button layout IS shrink-to-fit -- `block_child_width` routes an auto-width one through the
    // content-sized path), and its baseline is its content's however it scrolls (`child_baselines`).
    pub(crate) is_button: bool,
    // TABLE: whether the box is the table's OWN to size — an in-flow block-level table, whose auto width
    // shrink-to-fits its columns (§17.5.2). False where the parent handed it a box (a grid area, a flex item's
    // pushed size, an out-of-flow inset box), and then the width the caller passed is the used one.
    pub(crate) self_sizes: bool,
    // Whether the box's own BLOCK axis is the horizontal one — a vertical `writing-mode` (the oracle's
    // `blockAxisOf(el) === 'width'`). Its AUTO width is then a BLOCK size, so as a block-level child it
    // shrink-to-fits (`block_child_width`) instead of filling its containing block's inline size.
    pub(crate) block_axis_is_x: bool,
    // The horizontal EDGES with NO percentage basis — padding + border (`decl_edges_x`) and the margins
    // (`decl_margin_x`, `auto` counted as 0) as an INTRINSIC measure reads them, a percentage resolving to
    // nothing (`edgeInsets(el, null)`). The record's own `pl`/`pr`/`ml`/`mr` are cbW-resolved, which is the right
    // figure for LAYOUT and the wrong one for an intrinsic contribution.
    pub(crate) decl_edges_x: f64,
    pub(crate) decl_margin_x: f64,
    // TABLE CELL: the `%` fraction its `width` declared (NaN where it declares none) — a column's `pct`,
    // resolved against the width the columns share out rather than the table's own box (`distribute_columns`).
    pub(crate) cell_pct: f64,
    // TABLE CELL: its (min-content, max-content) contribution as the ORACLE measured it — NaN where native
    // measures the cell itself (`nlIntrinsicMeasurable`). A cell native cannot measure (a control's chrome, CJK
    // text, a nested grid, a `%` edge an intrinsic measure has no basis for) rides its resolved figures instead
    // of declining the whole table, exactly as an un-measurable grid track does.
    pub(crate) cell_min_content: f64,
    pub(crate) cell_max_content: f64,
    // TABLE CELL: its declared `height` is a MINIMUM, not a size (§17.5.3) — content taller than it grows the
    // box (the oracle's `growFloor`), and min/max-height clamp the result. Its natural flow height is kept in
    // `Box::natural_h`, which is the slack `vertical-align` distributes against.
    pub(crate) height_is_floor: bool,
    // TABLE CELL: how its content sits in the row-tall box (§17.5.3) — 0 baseline (its first baseline meets the
    // row's), 1 top, 2 middle, 3 bottom.
    pub(crate) cell_valign: u8,
    // TABLE ROW: the height it declares as a MINIMUM — the px length, or the `%` fraction resolved against what
    // the rows share out (each NaN where it declares none) — and its group's rank: 0 header, 1 body, 2 footer,
    // which decides who takes a declared table height's surplus.
    pub(crate) row_height: f64,
    pub(crate) row_pct: f64,
    pub(crate) row_rank: u8,
    // TABLE: `table-layout: fixed` is declared. With a width to hand out it sizes the columns from the first
    // row alone (`fixed_column_widths`); with `width: auto` there is nothing to distribute and the content
    // algorithm takes over, which an auto `width` already says.
    pub(crate) table_fixed: bool,
    pub(crate) flex_stretch: bool,
    pub(crate) flex_native: bool,
    // On a flex CONTAINER: `flex-direction` is a `*-reverse` value (its baseline candidates run backwards; an
    // rtl row reverses the main axis without this).
    pub(crate) flex_dir_reverse: bool,
    // A REPLACED leaf (img / svg / a control / iframe …): sized from its intrinsic size — DATA the walk
    // carries (a decoded image's natural size, a control's chrome, an svg's viewBox) — by `replaced_box`. `ratio`
    // = the intrinsic size is a real aspect ratio (an image, a canvas, a viewBox); `ratio_only` = a ratio with no
    // intrinsic SIZE (a viewBox): the box wants what its container gives it. It lays out no children.
    pub(crate) replaced: bool,
    pub(crate) ratio: bool,
    pub(crate) ratio_only: bool,
    // The box has no content height to floor a flex column's automatic minimum at (an image, a ratio box).
    pub(crate) shrinks_to_nothing: bool,
    // A REPLACED box's baseline (the oracle's `controlBaseline`): 0 none — an `<img>`, the only one that has
    // none at all; 1 a text-drawing control's font — the font box (`control_font_box`) centred in the content
    // box plus its ascent (`control_font_asc`); 2 a list box — its content box's bottom; 4 the BORDER box's
    // bottom, which every OTHER replaced box gives (a checkbox, a radio, a range, an image input, and the
    // non-controls: canvas, svg, video, iframe, object, embed, meter, progress, textarea). A `file` input is
    // not one of them — it draws text, so it is kind 1. (3 is unused; it carried a replayed list-box figure
    // until native learned to stack the rows itself.)
    pub(crate) control_baseline: u8,
    pub(crate) control_font_box: f64,
    pub(crate) control_font_asc: f64,
    pub(crate) intrinsic_w: f64,
    pub(crate) intrinsic_h: f64,
    // An OUT-OF-FLOW box (`out_of_flow`) native positions itself (`place_out_of_flow`): the record index of its
    // CONTAINING BLOCK (−1 = the oracle's whole box is replayed instead — an in-pass CB with percentage edges,
    // or a shrink-to-fit width native cannot measure — so nothing here is usable), its
    // insets resolved against the CB's padding box (NaN = auto), and which of its margins are `auto` (bit 1
    // left, 2 right, 4 top, 8 bottom — they take the slack between two insets).
    pub(crate) cb_index: i32,
    pub(crate) inset_top: f64,
    pub(crate) inset_right: f64,
    pub(crate) inset_bottom: f64,
    pub(crate) inset_left: f64,
    // Which of this box's margins are `auto` (1 left, 2 right, 4 top, 8 bottom) — the record carries the mask
    // because a resolved `auto` margin arrives as 0, indistinguishable from a declared one. The slack goes to
    // them: between the INSETS of an out-of-flow box (§10.3.7 / §10.6.4), and in the containing block for an
    // in-flow one (§10.3.3 — `margin: 0 auto`, how half the pages on the web centre their shell).
    pub(crate) auto_margins: u8,
    // HTML's LEGACY alignment on this box AS A CONTAINER (0 none, 1 center, 2 right, 3 left): `<center>` and
    // the `align` attribute move a narrower block-level descendant in its band the way `margin: auto` would.
    pub(crate) legacy_align: u8,
    // `text-indent` on a TEXT BLOCK: the px the indent narrows a line by, from the line's START edge (the
    // right one in rtl), resolved by the walk against the block's own content width. Which LINES take it: the
    // first, or with `hanging` every line BUT the first, and with `each_line` the first after every forced
    // break as well. The FLOW only — an INTRINSIC measure of an indented block is declined in the walk, so
    // nothing here carries an indent into `text_intrinsic`.
    pub(crate) indent_px: f64,
    pub(crate) indent_hanging: bool,
    pub(crate) indent_each_line: bool,
    // …and whether the FIRST-LINE indent is already spent: an anonymous text block in a MIXED block carries
    // its container's indent, but only the first group that places a line (and nothing after a block-level
    // child) counts as the block's first line. The per-line rules still apply — a `hanging` indent indents
    // every line of the third group too.
    pub(crate) indent_spent: bool,
    // An INTRINSIC-SIZE KEYWORD on `width` (0 none, 1 min-content, 2 max-content, 3 fit-content): the box is as
    // wide as its own content asks rather than as wide as the room it is given. Only an in-flow BLOCK-LEVEL box
    // carries one here — every other sizing path (a flex or grid item, an out-of-flow box, a replaced element)
    // has a basis of its own and the walk declines it there.
    pub(crate) width_kw: u8,
    // …and where that containing block is NOT a record of this pass — the viewport for a `fixed` box, an
    // ancestor above the pass root, a relatively-positioned inline — its PADDING BOX arrives instead, in the
    // pass's own (document) coordinates: `cb_index` is CB_RECT and these four are x / y / width / height, taken
    // from the containing block the PLACEMENT stamped on the box (`_lb.cbEl` — the walk reads that stamp rather
    // than resolving the question a second time). `place_out_of_flow` reads one or the other and does the same
    // arithmetic either way, so the only difference between a viewport-positioned box and an in-pass one is
    // where the rectangle came from.
    pub(crate) cb_rect: [f64; 4],
}
// `cb_index` for an out-of-flow box whose containing block is not in the pass but whose RECTANGLE is (cb_rect).
pub(crate) const CB_RECT: i32 = -2;

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
// How a NATIVE atomic hangs on its line when not by its own baseline (`nlAtomicAlignment`'s `NL_VA_CODE`): against the
// parent's font box, from the figure of that font its run carries.
const VA_MIDDLE: u8 = 1;
const VA_TEXT_TOP: u8 = 2;
const VA_TEXT_BOTTOM: u8 = 3;
const VA_BASELINE_MIDDLE: u8 = 4;
// A `<wbr>`: a zero-width soft-wrap opportunity carrying no metrics — it only lets the next word break
// before it (modelled as a width-0 collapsed space), and its presence keeps the flanking text runs distinct.
pub(crate) const RUN_WBR: u8 = 5;
// An OUT-OF-FLOW child of this text block: no advance, no line growth, no break opportunity — a marker that
// records where the flow had reached, which is that child's STATIC POSITION (§10.3.7).
pub(crate) const RUN_OOF: u8 = 6;

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
    // A TEXT run's ascent above its line's baseline; an ATOMIC's too (its own baseline plus any shift). On an
    // OPEN / CLOSE edge run this slot carries the edge width with NO percentage basis — what an INTRINSIC
    // measure reads, where `metric` is the resolved px the laid-out line uses.
    pub(crate) asc: f64,
    pub(crate) metric: f64,
    // The `white-space` mode of the element this run belongs to — not the block's. An inline may declare its
    // own, and each of the three behaviours the property controls is asked of the run that behaviour is about:
    // whether THIS text's spaces collapse, whether a break may fall at THIS space, whether THIS newline forces
    // one. (Chrome: `aaaa<span style="white-space:nowrap"> </span>bbbb` stays on one line, where the same space
    // in a wrapping span opens the line.)
    pub(crate) ws_mode: u8,
    // The TAB STOP a tab in this run advances to, as `tabStopOf` resolves it: `tab_px` is the spacing between
    // stops — the tab's OWN element's `tab-size`, so an inner `code { tab-size: 4 }` stops every 4 inside a
    // `pre { tab-size: 8 }`, counted in the BLOCK's space advance where the value is a number — and `tab_min`
    // is the block's half-space, the least a tab may advance. Stops are measured from the BLOCK's content
    // edge, so what a tab is worth depends on where the pen stands (`measure_at`'s `from`). The pair arrives
    // FINAL — a `tab-size` that resolved to zero took the block's letter-spacing as its spacing back in the
    // oracle's `tabStopOf` — so a `tab_px` of 0 means there is no stop to reach and a tab advances nothing.
    pub(crate) tab_px: f64,
    pub(crate) tab_min: f64,
}

impl Input {
    // An out-of-flow box native positions from its containing block (vs one whose oracle box is replayed).
    fn native_oof(&self) -> bool {
        self.out_of_flow != 0 && (self.cb_index >= 0 || self.cb_index == CB_RECT)
    }
    // This record with a border-box height IMPOSED on it (a flex item stretched to its line, or handed its
    // resolved main size) — the oracle's `layoutElement(child, {height, autoHeight: false})`: the declared
    // height is replaced (content-box per `box-sizing`), the min/max clamp still applies after
    // (layoutElementInner clamps every box). NaN imposes nothing; MEASURE_AUTO_HEIGHT asks for the box's
    // CONTENT height whatever it declares (the oracle's `measureItemHeight`: `{height: 0, autoHeight: true}`).
    fn with_imposed_height(self, h: f64) -> Input {
        if is_auto(h) {
            return self;
        }
        let mut n = self;
        if h == MEASURE_AUTO_HEIGHT {
            n.height = f64::NAN;
            n.item_auto_height = true;
            return n;
        }
        n.height = if n.border_box { h } else { (h - n.edges_y()).max(0.0) };
        n.item_auto_height = false;
        n.pushed_h_indefinite = false;
        n
    }
    // Sum of the horizontal / vertical non-content edges (padding + border), used to convert between
    // content-box and border-box widths/heights.
    fn edges_x(&self) -> f64 {
        self.pl + self.pr + self.bl + self.br
    }
    // The CONTENT width inside a border box — the oracle's `box.width - edge.left - edge.right`, subtracted
    // ONE SIDE AT A TIME because that is how the oracle spells it and floating-point subtraction is not
    // associative. It matters on exactly the box this is for: a SHRINK-TO-FIT width is `max-content + edges`
    // by construction, so its content width lands on the line-break boundary to the last bit, and summing the
    // four edges first put it one ULP under — 249.27343749999997 against the oracle's 249.2734375, which is
    // one more line in the float and a box a different height (`padding: 0 19.2px` around a 37-character run).
    fn content_w(&self, w: f64) -> f64 {
        ((w - (self.pl + self.bl)) - (self.pr + self.br)).max(0.0)
    }
    // How much of that is PERCENTAGE: what an intrinsic contribution leaves out (`decl_edges_x` resolves a
    // percentage to nothing) and what a box's OWN used width — a shrink-to-fit one — has to put back. Zero for
    // the common box, which declares no percentage edge at all.
    fn pct_edges_x(&self) -> f64 {
        self.edges_x() - self.decl_edges_x
    }
    // Whether the box lays its own content out from the RIGHT: its inline axis runs backwards (`direction:
    // rtl`) AND that axis is the horizontal one. In a VERTICAL writing mode the inline axis is the vertical
    // one, so `direction` orders the lines along it and leaves the horizontal (block) axis alone: the children
    // still start at the left content edge — which is what the oracle's block flow does, and what its `lineup`
    // and `staticCornerFor` read off the PHYSICAL inline-start rather than off `direction`.
    fn from_right(&self) -> bool {
        self.rtl != 0 && !self.block_axis_is_x
    }
    // The CONTENT height when the box's height is definite — declared or imposed, not a pushed auto height — as
    // the final box will be clamped (the oracle reads it back off `_lb.height` once `_lbDefiniteH` says so).
    fn definite_content_h(&self) -> Option<f64> {
        if is_auto(self.height) || self.item_auto_height || self.pushed_h_indefinite {
            return None;
        }
        let to_border = |v: f64| if is_auto(v) || self.border_box { v } else { v + self.edges_y() };
        Some((clamp_min_max(to_border(self.height), to_border(self.min_h), to_border(self.max_h)).max(0.0) - self.edges_y()).max(0.0))
    }
    // A flex COLUMN's main size as the oracle's `definiteMainHeight` has it: the definite content height, else a
    // positive min-height FLOOR, else NaN (nothing to resolve a percentage basis against).
    fn column_main(&self) -> f64 {
        if let Some(h) = self.definite_content_h() {
            return h;
        }
        let to_border = |v: f64| if is_auto(v) || self.border_box { v } else { v + self.edges_y() };
        if is_auto(self.min_h) || self.min_h <= 0.0 { f64::NAN } else { (to_border(self.min_h) - self.edges_y()).max(0.0) }
    }
    // This box with its percentage sizes resolved against a containing block of `cb_w` × `cb_h` (NaN = an
    // indefinite height: a percentage height is then `auto`, a percentage min / max-height no clamp).
    fn with_percent_sizes(self, cb_w: f64, cb_h: f64) -> Input {
        let mut n = self;
        let at = |frac: f64, basis: f64, current: f64| if frac.is_nan() { current } else if is_auto(basis) { f64::NAN } else { frac * basis };
        let [w, h, min_w, max_w, min_h, max_h] = self.pct_sizes;
        n.width = at(w, cb_w, n.width);
        n.height = at(h, cb_h, n.height);
        n.min_w = at(min_w, cb_w, n.min_w);
        n.max_w = at(max_w, cb_w, n.max_w);
        n.min_h = at(min_h, cb_h, n.min_h);
        n.max_h = at(max_h, cb_h, n.max_h);
        // …and a percentage height that resolved to AUTO leaves the box's bottom margin adjoining its last child's,
        // as an auto height does (the walk cannot say which without the basis).
        if !h.is_nan() {
            n.bottom_adjoins = is_auto(n.height);
        }
        let edge = |i: usize| self.edge_px[i] + self.edge_frac[i] * cb_w;
        if self.edge_frac.iter().any(|&f| f != 0.0) {
            (n.mt, n.mr, n.mb, n.ml) = (edge(0), edge(1), edge(2), edge(3));
            (n.pt, n.pr, n.pb, n.pl) = (edge(4), edge(5), edge(6), edge(7));
        }
        n
    }
    fn has_percent_sizes(&self) -> bool {
        self.pct_sizes.iter().any(|f| !f.is_nan()) || self.edge_frac.iter().any(|&f| f != 0.0)
    }
    // A flex item's resolved basis in a container whose main size is `main`: its percentage of that (auto where
    // the main size is indefinite), else the length the walk resolved.
    fn flex_basis_at(&self, main: f64) -> f64 {
        if self.flex_basis_frac.is_nan() {
            self.flex_basis_cb
        } else if is_auto(main) {
            f64::NAN
        } else {
            self.flex_basis_frac * main
        }
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
    // The box's FIRST and LAST baselines as offsets from its border-box top (the oracle's `boxBaselineOffset`):
    // a text block's first / last line baseline (the line's top + its ascent — strut and runs); a block, grid
    // or flex container's from the first / last in-flow child that has one (flex items in flex order); None
    // when no line is there to give one (a flex item then synthesises its bottom margin edge).
    pub(crate) first_baseline: Option<f64>,
    pub(crate) last_baseline: Option<f64>,
    // The baseline an INLINE-BLOCK made of this box hangs by — its last baseline under one more rule Blink applies
    // down the tree (CSS2 §10.8.1: a box whose `overflow` is not visible hangs from its bottom margin edge): a
    // SCROLL-CONTAINER child gives its bottom MARGIN edge, not its lines. The oracle's `boxBaselineOffset(el,
    // true, inlineBlock = true)`.
    pub(crate) inline_block_baseline: Option<f64>,
    // A TABLE CELL's natural flow height (`height_is_floor`): what its content alone came to, before its own
    // declared floor or min/max raised the box and before the row stretched it — the slack `vertical-align`
    // distributes against (the oracle's `_lbCellContentH`). None for every other box.
    pub(crate) natural_h: Option<f64>,
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
pub(crate) fn layout_block(inputs: &[Input], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], root_x: f64, root_y: f64, root_cb_w: f64) -> Outcome {
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
                        | DISPLAY_GRID
                )
            {
                children[p].push(i);
            }
        }
    }
    let mut boxes: Vec<Box> = inputs
        .iter()
        .map(|n| Box { nid: n.nid, x: 0.0, y: 0.0, w: 0.0, h: 0.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None })
        .collect();
    // Two phases: MEASURE lays the subtree out relative to each node's own border-box origin (so
    // collapse-through margins can propagate UP through returns without knowing final positions), then
    // PLACE walks once top-down adding absolute offsets. `failed` is set when a text block can't be
    // measured natively (bad font handle, or a tab / combining mark / CJK the L2 line breaker declines)
    // — the whole pass then falls back to JS.
    let root_w = resolve_width(&inputs[0], root_cb_w);
    // Bound to a name, never `let _`: the guard has to LIVE to the end of the pass — dropped at the semicolon
    // it would clear the memo again immediately, silently, with nothing measuring the loss.
    let _iw_guard = IwMemo::install(inputs.len());
    // Each record in a CELL: a parent resolves its children's percentages against the box it lays them out in
    // (`Input::with_percent_sizes`) and writes the resolved copy back before they are measured.
    let cells: Vec<Cell<Input>> = inputs.iter().copied().map(Cell::new).collect();
    let inputs: &[Cell<Input>] = &cells;
    let failed = std::cell::Cell::new(false);
    let mut root_fc = FloatCtx::new();
    measure(0, root_w, f64::NAN, inputs, runs, run_texts, grids, &children, &mut boxes, &failed, &mut root_fc, 0.0, 0.0);
    if failed.get() {
        return Outcome::Unsupported;
    }
    place(0, root_x, root_y, inputs, runs, run_texts, grids, &children, &mut boxes, &failed);
    if failed.get() {
        return Outcome::Unsupported; // an out-of-flow box sized in `place` met a construct the measure declines
    }
    Outcome::LaidOut(boxes)
}

// Measure text in a run's font (px), at a pen standing `from` px from the BLOCK's content edge. Only a TAB
// reads the pen, and it reads it because its advance is the gap to the next stop rather than a width of its
// own (`Run::tab_px`). None on a bad font handle.
fn measure_at(run: &Run, text: &[u16], from: f64) -> Option<f64> {
    crate::font::with_font(run.font, |fm| fm.measure_run(text, run.size, run.ls, run.ws, from, run.tab_px, run.tab_min))
}
// …and the same for text that CANNOT hold a tab, which needs no pen. The tokenizer splits on white space and
// a tab is white space, so every WORD is tab-free by construction; a literal space is one character that is
// not a tab. Two names rather than one `from` argument every caller has to reason about: measuring at the
// wrong pen is silent (a tab simply lands on a different stop), and a word site has no cheap pen to pass —
// `band_l` scans the floats, per word of every line.
fn measure_word(run: &Run, word: &[u16]) -> Option<f64> {
    measure_at(run, word, 0.0)
}

fn is_ws_u16(u: u16) -> bool {
    matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C)
}

// What the BLOCK decides about its lines — everything the runs do not carry themselves. They travel as one
// value because they would otherwise be a row of interchangeable scalars at a 13-argument call: `ws_mode` and
// `align` are both `u8`, and transposing them compiles clean while quietly making every `nowrap` block wrap.
#[derive(Clone, Copy)]
struct LineStyle {
    // The BLOCK's own `white-space`, which is the only thing it still decides: whether the line may break at
    // all (`outerWraps`). A non-wrapping RUN forbids breaks inside itself; the opportunity BEFORE it is the
    // block's to give.
    ws_mode: u8,
    align:   u8,
    rtl:     bool,
    indent:  (f64, bool, bool, bool), // `text-indent`: px, hanging, each-line, first-line-spent (Input::indent_px)
}

// Greedy line layout for a text block's run/marker STREAM (`runs` / `run_texts` parallel, this block's
// slice). TEXT runs tokenize into words (maximal non-`[ \t\n\r\f]+` — NBSP is NOT a break), each measured
// in its own font; a collapsible space (the first ws at a boundary, that run's spaceW) is the break
// opportunity. OPEN/CLOSE are an inline element's horizontal edges: OPEN reserves `metric` in the fit
// test (openEdgeWidth) and flushes onto the first line content lands on; CLOSE adds `metric` on the
// current line. BR forces a line break. A line's box is max(ascent)+max(descent) over the STRUT
// (`strut_lh` / `strut_asc`) and the runs on it (each run's descent = line_height - asc), §10.8 — so a
// taller-metric run grows the box even under a fixed line-height; an empty line (a lone/leading `<br>`)
// is the bare strut (asc + desc == strut_lh). Returns the content height (Σ line heights) and the first / last
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
    style: LineStyle,
) -> Option<LineLayout> {
    let LineStyle {ws_mode, align, rtl, indent} = style;
    // The three orthogonal `white-space` behaviours (see Input::ws_mode). `no_wrap` keeps the old name for the
    // soft-wrap gates below: a line SOFT-wraps under normal (0) / pre-wrap (3) / pre-line (4), never under
    // nowrap (1) / pre (2) — and it is what a space writes into its own break OPPORTUNITY, because the
    // opportunity belongs to the run that queued the space, not to whatever meets it. `preserve` keeps every
    // space as a real advance (pre / pre-wrap) rather than collapsing runs of whitespace to one
    // break-opportunity; `break_nl` makes a literal newline force a break.
    // …asked of the RUN that the behaviour is about, because an inline may declare its own `white-space`
    // (`Run::ws_mode`), and every run in the stream carries its owner's — the `<br>` and edge runs included.
    let outer_wraps = !(ws_mode == 1 || ws_mode == 2);
    let no_wrap_of = |m: u8| m == 1 || m == 2;
    let preserve_of = |m: u8| m == 2 || m == 3;
    let break_nl_of = |m: u8| m >= 2;
    let strut_desc = strut_lh - strut_asc;
    // `text-indent` NARROWS the line from its start edge (the oracle's `applyIndent`: `lineLeft += px` in ltr,
    // `lineRight -= px` in rtl) rather than moving a cursor inside it, so an indented empty line is still
    // empty. `indent_first` is the oracle's `indentNext`: true for the FIRST line, and set again after a forced
    // break under `each-line` (`next_line_indent`); the indent applies when it DISAGREES with `hanging`, which
    // is what makes `hanging` indent every line BUT the first.
    let (indent_px, indent_hanging, indent_each_line, indent_spent) = indent;
    // A Cell because the band closures below read it while the line loop writes it (one owner thread, no
    // borrow to keep): `indent_now` is what THIS line gives up, 0 on every line that takes no indent. The seed
    // is the oracle's `indentNext = true` — unless this block's first line is not the BLOCK's first, where the
    // flag starts false and a `hanging` indent is the one that applies.
    let indent_first = !indent_spent;
    let indent_now = std::cell::Cell::new(if indent_first != indent_hanging { indent_px } else { 0.0 });
    // The usable width of the line whose top is at `top + t` — the float band there, or the full content
    // width when there are no floats (kept exact, not `cr - cl`, so the no-float path never drifts) — less
    // whatever the indent takes off this line.
    let raw_band_w = |t: f64| -> f64 {
        if floats.is_empty() {
            content_w
        } else {
            let (bl, br) = float_band(floats, top + t, strut_lh, cl, cr);
            br - bl
        }
    };
    // …and where that band starts, from the content edge (0 with no floats). The indent moves the START edge,
    // which in rtl is the RIGHT one: the origin is the band's left either way, so in rtl the narrowing shows up
    // only in the width — which `close_line`'s `free` already carries into the alignment shift — and adding it
    // to the origin too would move the line twice.
    let raw_band_l = |t: f64| -> f64 {
        if floats.is_empty() {
            0.0
        } else {
            float_band(floats, top + t, strut_lh, cl, cr).0 - cl
        }
    };
    let band_w = |t: f64| raw_band_w(t) - indent_now.get();
    let band_l = |t: f64| raw_band_l(t) + if rtl { 0.0 } else { indent_now.get() };
    // A line has closed: the next one takes the indent only under `each-line`, and only after a FORCED break
    // (the oracle's `endLine`, where `kind === 'forced'`).
    let next_line_indent = |forced: bool| {
        let takes = if indent_each_line && forced { !indent_hanging } else { indent_hanging };
        indent_now.set(if takes { indent_px } else { 0.0 });
    };
    let mut line_x = 0.0f64;
    // The trailing white space on `line_x` since the last content — a collapsed space placed ahead of the word
    // that may then wrap away from it, or preserved spaces — which HANGS at a soft wrap: the line ends before it
    // for alignment (the oracle's `trailingHang` / `trailingPreserved`).
    let mut hang = 0.0f64;
    // …and the same for PRESERVED trailing spaces, which the oracle keeps in a counter of their own
    // (`trailingPreserved`). The two are MUTUALLY EXCLUSIVE — every placement zeroes the other — and only a
    // line that WRAPPED hangs the preserved ones (`alignLine`: `trailingHang + (kind === 'wrap' ? … : 0)`).
    let mut hang_pre = 0.0f64;
    let mut total = 0.0f64;
    // How many lines have CLOSED. A marker waiting on an opening edge recorded the cursor it stood at; that
    // cursor still means something only while its line is still open — a wrap since then starts it over.
    let mut line_no = 0usize;
    // The current line's box, seeded to the strut and grown by each placed run's ascent / descent.
    let mut line_asc = strut_asc;
    let mut line_desc = strut_desc;
    let mut line_has_content = false;
    // Open inline edges not yet closed: (pending-open width, already-flushed?). openEdgeWidth = Σ of the
    // unflushed pendings — reserved in the fit test until the first content flushes it onto the line.
    let mut open: Vec<(f64, bool)> = Vec::new();
    // A collapsed space waiting for the next word: (width, asc, desc) of its run, and whether it is a break
    // OPPORTUNITY. That last is the QUEUING run's to say, not the consuming one's — the oracle leaves a
    // `barrier` of `'hard'` behind a non-wrapping run's trailing space, so `aaa <span style="white-space:
    // normal">bbbbbbbb</span>` in a `nowrap` block does not break before the span however the span wraps.
    let mut pending_space: Option<(f64, f64, f64, bool)> = None;
    // An atomic inline is a break opportunity on BOTH sides regardless of whitespace: this flag carries the
    // AFTER-side break (a zero-width break opportunity) to the next box, so a word glued to an atomic can still
    // wrap before it. (The BEFORE-side break is unconditional in the RUN_ATOMIC arm itself.) Reset on any word
    // placement and at a line break.
    let mut atomic_break = false;
    // …and the same for a text run that ENDS OPEN: a WIDE character may break on both sides, and so may a
    // trailing hyphen or dash, so either leaves an opportunity for whatever the next run starts with (the
    // oracle's `endsWithBreak`) — where a word STARTING with a wide character may break before it however the
    // previous run ended (`startsWithWide`), which the unit loop's `may_break` asks for itself. Carried across
    // runs because that is where it matters: `abcdefghij<b>日本語</b>klmnopqrst` is three runs, and native
    // merges only same-font ones — a plain `<b>` around a Japanese word, or around the hyphen of
    // `well<b>-</b>known`, already splits them.
    let mut ends_open = false;
    // Close the current line and start a fresh one. `soft_break!` is the geometry alone (a mid-word wrap, a
    // between-words wrap, a break before an atomic — where no pending space or after-atomic break carries over);
    // `break_line!` adds the resets a HARD break needs (a <br>, a preserved/pre-line newline, an empty line's
    // bare strut) so a queued space / atomic opportunity does not survive it. Capture the surrounding line state.
    // The first / last line CLOSED, as (top, ascent) — a line a `<br>` left empty is a line too (its bare strut).
    let mut first_line: Option<(f64, f64)> = None;
    let mut last_line: Option<(f64, f64)> = None;
    // The atomic runs placed on the current line (run index, x from the content edge), settled against the
    // line's top + ascent — and moved by the line's alignment — at close.
    let mut line_atomics: Vec<(usize, f64)> = Vec::new();
    let mut atomics: Vec<(usize, f64, f64, f64)> = Vec::new();
    // …and the same for the OUT-OF-FLOW markers on the line (record index, x from the content edge): their
    // static position is the inline offset the flow had reached and the line's TOP, both settled at close so
    // the line's alignment moves them exactly as it moves the atomics.
    let mut line_oofs: Vec<(usize, f64, f64)> = Vec::new();
    let mut oofs: Vec<(usize, f64, f64)> = Vec::new();
    // …and the markers that cannot know that yet, because an inline box around them still holds an UNPLACED
    // opening edge: (record index, the inlines' relative offset x / y, the cursor and line to fall back on).
    // Where the flow has reached is then wherever that edge turns out to be placed — which may be a later line
    // — exactly the oracle's `pendingStatic`, settled from the inline's first fragment.
    let mut pending_oofs: Vec<(usize, f64, f64, usize, f64, usize)> = Vec::new();
    // Close the current line: `$wrap` says a soft wrap closed it (its hanging white space is not part of the
    // line's extent; a hard break keeps preserved spaces before it). The line's atomics move by the alignment
    // (the oracle's `alignLine`): `right` takes the free width, `center` half — clamped at zero in ltr, where an
    // overflowing line stays at the start edge; in rtl the overflow hangs off the LEFT, so the shift goes negative.
    macro_rules! close_line {
        ($wrap:expr) => {{
            if first_line.is_none() {
                first_line = Some((total, line_asc));
            }
            last_line = Some((total, line_asc));
            let end = if $wrap { line_x - hang - hang_pre } else { line_x };
            let free = band_w(total) - end;
            // A line the flow never put anything on is not aligned at all (the oracle's `forceBreak` calls
            // `alignLine` only `if (linePlaced)`): a `<br>` closing a line that holds nothing but an
            // out-of-flow marker leaves that marker at the start edge, not at the far one.
            let dx = if !line_has_content {
                0.0
            } else {
                match align {
                    1 => if rtl { free } else { free.max(0.0) },
                    2 => if rtl { (free / 2.0).min(free) } else { (free / 2.0).max(0.0) },
                    _ => 0.0,
                }
            };
            for (ri, x) in line_atomics.drain(..) {
                atomics.push((ri, x + dx, total, line_asc));
            }
            // A marker's Y was frozen where it was recorded (the oracle reads `staticX`/`staticY` together and
            // only ever shifts x afterwards): a line that later DROPS below a float moves `total`, and the box
            // does not go with it. Only the alignment reaches it here.
            for (ci, x, y) in line_oofs.drain(..) {
                oofs.push((ci, x + dx, y));
            }
            total += line_asc + line_desc;
            line_no += 1;
            next_line_indent(!$wrap); // a soft wrap is not a forced break
        }};
    }
    // The opening edges just went onto the line, so every marker waiting on them now knows where the flow had
    // reached: the cursor that follows them, on the line they landed on. The RELATIVE offset of the inlines
    // around it is NOT re-applied here — the oracle reads this corner back off the inline's own fragment
    // (`line.minX + ce.left`, `line.y`) and that reading discards the offset it had added to the cursor. (Which
    // is a divergence from Chrome, but so is the whole shape: Chrome splits a block-level box out of the inline
    // it is written in, and puts its static position on a line of its own. Native's contract is the oracle.)
    // An inline's opening edge is PLACED: it goes onto the line at the cursor and makes the line a placed one
    // (the oracle's `flushOpenEdges`, whose `seedStrut(); linePlaced = true` is what an alignment then reads).
    macro_rules! flush_open_edges {
        () => {{
            // …asked of the SUM, as `placeOnLine`'s `if (pending)` asks `openEdgeWidth()`: a negative margin
            // that cancels an inner padding leaves NOTHING to place, and the oracle then places nothing at all
            // — the fragment starts where the text does, and the line is not a placed one for it.
            let total_open: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
            if total_open != 0.0 {
                for o in open.iter_mut() {
                    if !o.1 {
                        line_x += o.0;
                        o.1 = true;
                    }
                }
                line_has_content = true;
            }
        }};
    }
    macro_rules! settle_pending_oofs {
        () => {{
            // Asked once per placed word and atomic, and there is almost never one waiting: the length test
            // keeps that to a load and a branch rather than building a `Drain` guard per placement.
            if !pending_oofs.is_empty() {
                // What the oracle settles a `pendingStatic` marker to is `line.minX + from.ce.left` — the
                // content-left of the marker's OWN inline fragment. That is the cursor the marker STOOD at
                // (recorded at push, the pending collapsed space counted in: the oracle places such a space
                // where it meets it, exactly as for a marker that does not wait) plus that inline's own
                // opening edge, and not one px more. Not the whole open stack: an inline that opened AFTER the
                // marker has its edge past the marker, not before it, so only the first `depth` entries count.
                // A wrap since then throws the recorded cursor away — the fragment starts the new line.
                for (ci, rx, _, depth, at, was) in pending_oofs.drain(..) {
                    // …measured from the BAND, not from the content edge: a line too narrow for its first word
                    // DROPS below the float (`total` moves with no line closing), and the fragment then starts
                    // in the wider band it landed in. Only the offset along the line survives the drop.
                    let base = band_l(total) + if was == line_no { at } else { 0.0 };
                    let edges: f64 = open.iter().take(depth).filter(|o| !o.1).map(|o| o.0).sum();
                    if rtl {
                        // …an rtl corner included. Its x is the container's edge and never was the cursor's,
                        // but its y IS the static position — which for a marker that waited is the line the
                        // inline's edge landed on, the relative offset dropped with it, exactly as in ltr.
                        oofs.push((ci, content_w + rx, total));
                    } else {
                        line_oofs.push((ci, base + edges, total));
                    }
                }
            }
        }};
    }
    // …and start a fresh one.
    macro_rules! soft_break {
        () => {{
            close_line!(true);
            line_x = 0.0; // (`hang` is reset by the content the wrap moves onto the fresh line)
            line_asc = strut_asc;
            line_desc = strut_desc;
            line_has_content = false;
        }};
    }
    macro_rules! break_line {
        () => {{
            close_line!(false);
            line_x = 0.0;
            hang = 0.0;
            hang_pre = 0.0;
            line_asc = strut_asc;
            line_desc = strut_desc;
            line_has_content = false;
            pending_space = None;
            atomic_break = false;
            ends_open = false;
        }};
    }

    for (ri, run) in runs.iter().enumerate() {
        match run.kind {
            RUN_OPEN => {
                open.push((run.metric, false));
            }
            RUN_CLOSE => {
                open.pop(); // LIFO; an unflushed (empty-inline) open's pending is dropped, matching JS
                line_x += run.metric;
                if run.metric != 0.0 {
                    line_has_content = true;
                    hang = 0.0;
                    // (`hang_pre` is NOT cleared: an edge is `edge` to the oracle, which leaves the preserved
                    // spaces before it hanging — only a real placement ends their run.)
                }
            }
            RUN_BR => {
                if !open.is_empty() {
                    return None; // <br> inside an open inline edge (fragment) — defer to JS
                }
                break_line!(); // an empty line's box is the bare strut
                // …and a `<br clear>` moves the flow past the floats it names before the next line opens
                // (HTML's pre-CSS float break; the oracle's `brClear` / `clearanceY`). The side arrives
                // resolved on the run — 1 left, 2 right, 3 both — because `clear: inline-start` is a
                // question about the containing block's direction, which the walk has and this does not.
                // Moving `total` is the whole move: `band_l` / `band_w` read it when they are called, so
                // the band, the indent and the rtl origin all come from the new y (the oracle needs an
                // explicit `retakeBand()` there only because it caches them).
                let clear = run.metric as u8;
                if clear != 0 {
                    let fy = top + total;
                    let below = clearance_y(floats, fy, clear);
                    if below > fy {
                        total += below - fy;
                    }
                }
            }
            RUN_TEXT => {
                // This TEXT's own `white-space`: whether ITS spaces are real advances, whether a break may
                // fall at one of them, whether ITS newlines force a break. All three are the run's, not the
                // block's — an inline declaring `nowrap` holds its own words together inside a wrapping
                // paragraph, and one declaring `pre` keeps its own spaces.
                let ws_mode = run.ws_mode;
                let (no_wrap, preserve, break_nl) = (no_wrap_of(ws_mode), preserve_of(ws_mode), break_nl_of(ws_mode));
                let text = run_texts.get(ri).and_then(|t| t.as_ref())?;
                // A run that does not soft-wrap is ONE token: the oracle places `collapseRun(…)` less a
                // trailing collapsible space in a single `placeOnLine`, and the only decision the line makes
                // about it is whether to break BEFORE it. So the fit test is asked ONCE, of the whole run,
                // rather than word by word — which is what let a `<span style="white-space:nowrap">` place its
                // first word and overflow the rest. Only where the LINE may break at all (`outerWraps`, the
                // block's mode): inside an unbreakable block there is nothing to decide.
                //
                // The unit is the run and never more: the oracle tokenises per text NODE, so a `<b>` inside
                // the span is a second run with a second decision. Under a PRESERVING mode the unit is the
                // first newline-SEGMENT — a newline after it breaks the line regardless.
                let space_w = measure_word(run, &[0x20])?;
                // How much of the run's own leading white space the pre-pass has already placed, and whether
                // it placed any (see below).
                let mut lead_skip = 0usize;
                let mut lead_space = false;
                if no_wrap && outer_wraps {
                    // …but only where the answer can change anything: either something OPENS the line here (a
                    // space that breaks, a `<wbr>`/atomic, a hyphen or a wide character) so the unit may move
                    // to the next line, or the line is EMPTY and the unit may drop below a float. Asked before
                    // the measure, so a run glued straight to a letter — the common case — pays two branches.
                    let breaks = line_has_content
                        && (pending_space.is_some_and(|(_, _, _, b)| b) || atomic_break || ends_open);
                    let may_drop = !line_has_content && !floats.is_empty();
                    if breaks || may_drop {
                        let end = if break_nl {
                            text.iter().position(|&u| u == 0x0A).unwrap_or(text.len())
                        } else {
                            text.len()
                        };
                        // The oracle strips a run's LEADING white space only at a line start, which is an
                        // empty line or one already ending in a real hanging space (`collapseRun`'s
                        // `lineX === lineLeft || lineEndsWithSpace`). Anywhere else it stays in the body and
                        // in the width the fit test is asked of. A PRESERVED space is not a hanging one, so
                        // the zero-width marker does not count.
                        // …and only a COLLAPSING run ever asks: a preserved space is kept wherever it sits,
                        // so both readers below already stand behind `!preserve`.
                        let at_line_start = !preserve
                            && (!line_has_content || pending_space.is_some_and(|(w, _, _, _)| w != 0.0));
                        // …and `body` is the oracle's string test: a run that is non-empty but zero-advance
                        // (a U+200B) is still a body, and still asks the question.
                        let has_body = if preserve {
                            end > 0
                        } else {
                            text[..end].iter().any(|&u| !is_ws_u16(u))
                        };
                        let pending_w = pending_space.map_or(0.0, |(w, _, _, _)| w);
                        let ow: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                        let room = band_w(total) + LINE_FIT_EPS;
                        let mut unit = 0.0f64;
                        // A run with no BODY asks neither question below, so it measures nothing here: the
                        // collapse branch in the main loop reaches its white space and does that work once.
                        if has_body {
                            let mut k = 0usize;
                            let mut first = true;
                            // …and the early-out only where nothing else needs the full width: the float drop
                            // below is asked of the WHOLE run (`retakeBand(runW + openEdgeWidth())`), so a
                            // truncated prefix would drop the line on the wrong answer.
                            let stop_at = if floats.is_empty() { room } else { f64::INFINITY };
                            while k < end && line_x + pending_w + ow + unit <= stop_at {
                                if is_ws_u16(text[k]) {
                                    let ws_start = k;
                                    while k < end && is_ws_u16(text[k]) {
                                        k += 1;
                                    }
                                    if preserve {
                                        // …measured where it will SIT: preserved white space may hold a tab,
                                        // whose advance is the gap to the next stop from the block's content
                                        // edge, so the pen this piece starts at is part of its width.
                                        unit += measure_at(run, &text[ws_start..k], band_l(total) + line_x + pending_w + ow + unit)?;
                                    } else if k < end && !(first && at_line_start) {
                                        // …one space per retained gap; a TRAILING collapsible space hangs outside
                                        // the run, so it is no part of what has to fit.
                                        unit += space_w;
                                    }
                                } else {
                                    let w_start = k;
                                    while k < end && !is_ws_u16(text[k]) {
                                        k += 1;
                                    }
                                    unit += measure_word(run, &text[w_start..k])?;
                                }
                                first = false;
                            }
                        }
                        if breaks && has_body && line_x + pending_w + ow + unit > room {
                            soft_break!();
                            pending_space = None;
                            atomic_break = false;
                            ends_open = false;
                            // …and the oracle decided `atLineStart` BEFORE this break, so a leading collapsible
                            // space it kept is part of the body and goes down with it on the fresh line. The
                            // word loop below would drop it (nothing precedes it there), so it is placed here
                            // and the loop starts past it.
                            if !preserve && !at_line_start {
                                if let Some(w0) = text[..end].iter().position(|&u| !is_ws_u16(u)) {
                                    if w0 > 0 {
                                        lead_space = true;
                                        lead_skip = w0;
                                    }
                                }
                            }
                        }
                        // …and a line still too narrow for the whole unit DROPS below the float instead (the
                        // oracle's `retakeBand(runW + openEdgeWidth())`, asked of the whole run and not of its
                        // first word — a `nowrap` span beside a float goes under it, not through it). Asked of
                        // the line the unit LANDS on, which is why the leading space above is only NOTED here
                        // and placed below: putting it down first would make the line look occupied.
                        if has_body && !floats.is_empty() && !line_has_content && unit + ow > band_w(total) + LINE_FIT_EPS {
                            let fy = top + total;
                            let at = float_fit_y(floats, fy, unit + ow + indent_now.get(), cl, cr, strut_lh);
                            if at > fy {
                                total += at - fy;
                            }
                        }
                        // …and only now does the kept leading space go down (the oracle's `collapseRun` put it
                        // inside the body, so it rides the line the body landed on).
                        if lead_space {
                            line_x += space_w;
                            line_asc = line_asc.max(run.asc);
                            line_desc = line_desc.max(run.line_height - run.asc);
                            line_has_content = true;
                            hang = 0.0;
                            hang_pre = 0.0;
                        }
                    }
                }
                // Asked ONCE per run so the per-word scans below are skipped outright on the runs that hold
                // neither — almost all of them (these are per word of every line layout).
                let run_has_wide = text.iter().any(|&u| is_wide_unit(u));
                let run_has_hyphen = text.iter().any(|&u| is_hyphen_unit(u));
                let mut i = lead_skip;
                while i < text.len() {
                    if is_ws_u16(text[i]) {
                        if preserve {
                            // pre / pre-wrap: every space is a REAL advance (kept, not collapsed); a newline
                            // forces a break; a tab / other control is not modelled. Under pre-wrap a preserved
                            // space is ALSO a soft-wrap opportunity — carried as a zero-width `pending_space` so
                            // the word branch may break before the next word (the space itself already advanced
                            // the line and hangs at a wrap). Leading whitespace is KEPT (code indentation).
                            while i < text.len() && is_ws_u16(text[i]) {
                                match text[i] {
                                    0x0A => {
                                        // A preserved newline ends this line with the open edges FLUSHED onto
                                        // it (`flushOpenEdges(); forceBreak();`): they go down here, and the
                                        // line becomes a PLACED one, so its `text-align` moves what sits on it
                                        // — a marker waiting on one of those edges included.
                                        settle_pending_oofs!();
                                        flush_open_edges!();
                                        break_line!(); // newline → forced break
                                        // …and the SEGMENT it opens drops below a float as one unit, exactly
                                        // as the first did: the oracle runs `retakeBand(runW + …)` for every
                                        // segment, not only the run's first (`segments.forEach`).
                                        if no_wrap && outer_wraps && !floats.is_empty() {
                                            let from = i + 1;
                                            let seg_end = text[from..]
                                                .iter()
                                                .position(|&u| u == 0x0A)
                                                .map_or(text.len(), |p| from + p);
                                            // (no open edge can be pending here — the flush above emptied the
                                            // stack and nothing opens between a newline and the segment it
                                            // starts — so the unit is the segment alone)
                                            if seg_end > from {
                                                let seg_w = measure_at(run, &text[from..seg_end], band_l(total) + line_x)?;
                                                if seg_w > band_w(total) + LINE_FIT_EPS {
                                                    let fy = top + total;
                                                    let at = float_fit_y(floats, fy, seg_w + indent_now.get(), cl, cr, strut_lh);
                                                    if at > fy {
                                                        total += at - fy;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    // …and a preserved TAB is the same placement with a different advance: the
                                    // gap from the pen to the next stop rather than a width of its own. So it
                                    // joins this arm rather than having one, and the advance is taken below,
                                    // once the pen is where the tab actually starts.
                                    0x20 | 0x09 => {
                                        // A preserved space is content on the line: it grows the line box by its
                                        // run's metrics as a word would (a lone space in a larger font is a fragment
                                        // there). It goes through the oracle's `placeOnLine` like any other run,
                                        // so the open edges are PLACED before it — and a marker waiting on one
                                        // settles here, on this line, rather than wherever the next word lands.
                                        settle_pending_oofs!();
                                        line_has_content = true; // the space itself is content on this line
                                        flush_open_edges!();
                                        // A COLLAPSED space still waiting from an earlier run is placed first —
                                        // the oracle placed it where it met it, and a preserved space is a
                                        // placement like any other, so it does not swallow the one before it.
                                        if let Some((w, a, d, _)) = pending_space.take() {
                                            line_x += w;
                                            line_asc = line_asc.max(a);
                                            line_desc = line_desc.max(d);
                                            if w != 0.0 {
                                                // …a REAL collapsed space ENDS the run of preserved ones before
                                                // it: the oracle places it with `hangs`, whose `!edge` arm
                                                // zeroes `trailingPreserved` before `placePreservedSpace`
                                                // re-seeds it. The zero-width marker is only an opportunity and
                                                // ends nothing.
                                                hang_pre = 0.0;
                                            }
                                        }
                                        // Measured HERE, after the waiting space and the open edges have moved
                                        // the pen: a tab's advance is the gap to the next stop from the block's
                                        // content edge, and everything placed before it on this line is part of
                                        // where it stands. (The oracle reaches the same pen as
                                        // `lineX + openEdgeWidth() - content.x`.)
                                        let adv = if text[i] == 0x09 {
                                            measure_at(run, &text[i..i + 1], band_l(total) + line_x)?
                                        } else {
                                            space_w
                                        };
                                        line_x += adv;
                                        hang = 0.0;              // …and it is not a COLLAPSED hang any more
                                        if no_wrap {
                                            // A `pre` run is placed WHOLE, through the oracle's non-wrapping
                                            // branch, where `placeOnLine`'s `!edge` arm zeroes the preserved
                                            // hang: its spaces are content on the line, never hanging off it.
                                            // (`placePreservedSpace`, which seeds that hang, is the wrapping
                                            // branch's alone.) It still ENDS a `pre-wrap` hang before it.
                                            hang_pre = 0.0;
                                        } else {
                                            hang_pre += adv;
                                        }
                                        line_asc = line_asc.max(run.asc);
                                        line_desc = line_desc.max(run.line_height - run.asc);
                                        // …and it REPLACES whatever opportunity the text before it left, just
                                        // as a collapsed space does: the oracle sets `barrier` at ANY trailing
                                        // white space — `null` where the run wraps, `'hard'` where it does not.
                                        // A `pre` run leaving none at all is what let a hyphen, a wide
                                        // character or an atomic on the far side of it open the line. Zero
                                        // width, because the advance is already on the line.
                                        ends_open = false;
                                        atomic_break = false;    // …the atomic's / `<wbr>`'s opportunity too:
                                                                 // the oracle keeps ONE `barrier`, and a space
                                                                 // overwrites whatever stood there
                                        pending_space = Some((0.0, run.asc, run.line_height - run.asc, !no_wrap));
                                    }
                                    _ => return None, // \r / \f — not modelled
                                }
                                i += 1;
                            }
                        } else {
                            // collapse (normal / nowrap / pre-line): consume the whitespace run. Under pre-line
                            // each NEWLINE it holds forces a break (spaces around it collapse away); otherwise the
                            // run collapses to a single break-space. A run of N newlines makes N breaks (blank
                            // lines), so count them.
                            let mut nl = 0u32;
                            while i < text.len() && is_ws_u16(text[i]) {
                                if text[i] == 0x0A {
                                    nl += 1;
                                }
                                i += 1;
                            }
                            if break_nl && nl > 0 {
                                // …and a `pre-line` newline ends its line the same way a preserved one does,
                                // with the open edges on it — but only where the RUN carries real content, so
                                // the oracle reaches the break through `placeTextRun` at all. A whitespace-ONLY
                                // run takes its collapsed branch instead, which places nothing and flushes
                                // nothing (`NON_WS_RE` / `PRESERVING_WS` in `placeInlineChild`).
                                if text.iter().any(|&c| !is_ws_u16(c)) {
                                    settle_pending_oofs!();
                                    flush_open_edges!();
                                }
                                // The BREAK below stays unconditional even there, though, and that is a KNOWN
                                // divergence rather than an oversight: the oracle's collapsed branch never
                                // breaks at all, so `<div style="white-space:pre-line">\n<b>aa</b></div>` is
                                // 22 in the oracle and 44 in native — which is what Chrome measures. Native is
                                // the right side; the ORACLE is the one to fix, in its own increment
                                // (`oracle_pre_line_newline_in_inline`), so native is not bent to match it.
                                for _ in 0..nl {
                                    break_line!();
                                }
                            } else if !line_has_content {
                                // At a line start the space itself collapses away — but the BARRIER it leaves
                                // does not: the oracle sets `barrier` from a whitespace-only run whether or not
                                // it placed anything (`modeWraps(owner) ? null : 'hard'`). A non-wrapping run
                                // leaves HARD, which an atomic after it may neither break at nor drop below a
                                // float at; a wrapping one leaves null, which CLEARS whatever stood there.
                                // Zero metrics as well as zero width: nothing was placed, so nothing grows the
                                // line box — a taller space that collapsed away was raising the line by its own
                                // leading.
                                ends_open = false;
                                atomic_break = false;
                                pending_space = if no_wrap {
                                    Some((0.0, 0.0, 0.0, false))
                                } else {
                                    None
                                };
                            } else {
                                match pending_space {
                                    // A REAL collapsed space is already waiting: a run of white space is ONE
                                    // space, so this one collapses away — but its OPPORTUNITY survives. The
                                    // oracle rescues `barrier` to `null` for a wrapping segment that starts
                                    // with white space arriving on a line that already ends with one, which is
                                    // how a `nowrap` block's space still opens a line for the wrapping inline
                                    // after it.
                                    Some((w, a, d, b)) if w != 0.0 => {
                                        if !no_wrap && !b {
                                            pending_space = Some((w, a, d, true));
                                        }
                                    }
                                    // …otherwise this space takes the slot: either nothing was waiting, or all
                                    // that was is the zero-width OPPORTUNITY a preserved space left behind
                                    // (the oracle's `lineEndsWithSpace` is false after one, so it places this
                                    // space like any other).
                                    _ => {
                                        // The oracle PLACES it where it meets it (`placeInlineChild`'s
                                        // whitespace branch, under the same `lineX > lineLeft` this
                                        // `line_has_content` stands for), and placing anything puts the open
                                        // inline edges down first. So the edges go down HERE — and a marker
                                        // written after them is not waiting on anything, which is what lets it
                                        // keep the relative offset of its own inline. The space itself still
                                        // only waits: one the next wrap drops grows nothing.
                                        settle_pending_oofs!();
                                        flush_open_edges!();
                                        // …and it REPLACES the opportunity the text before it left (a hyphen,
                                        // a wide character): the oracle overwrites `barrier` at any trailing
                                        // white space. Whether it breaks is ITS OWN mode's to say — the
                                        // whitespace-only-node arm is `modeWraps(owner) ? null : 'hard'`.
                                        ends_open = false;
                                        atomic_break = false;    // …as above: one barrier, and this is it now
                                        pending_space = Some((space_w, run.asc, run.line_height - run.asc, !no_wrap));
                                    }
                                }
                            }
                        }
                    } else {
                        let start = i;
                        while i < text.len() && !is_ws_u16(text[i]) {
                            i += 1;
                        }
                        let word = &text[start..i];
                        // A WORD holds no tab: the tokenizer splits on white space and a tab is white space.
                        // So it is measured with no pen, exactly as the oracle measures it (`breakUnits` calls
                        // `measureRun` with neither `from` nor `tab`), and so are the pieces it splits into.
                        let width = measure_word(run, word)?;
                        // `space_before` is the ADVANCE that is waiting; `space_breaks` is whether it opens a
                        // line here, which is the mode of the run that queued it.
                        let (space_before, sw, sasc, sdesc, space_breaks) = match pending_space.take() {
                            Some((s, a, d, b)) => (true, s, a, d, b),
                            None => (false, 0.0, 0.0, 0.0, false),
                        };
                        // A word glued to the previous one across a run boundary — no space between, a mixed-font
                        // word like `foo<b>bar</b>` or `H<sub>2</sub>O` where the edgeless inline emits no
                        // OPEN/CLOSE run to split the fonts — has `space_before` false, so the break-before test
                        // below already skips it: it places right after the leading segment, glued, and its tail
                        // simply overflows the line when the whole unit runs long. This matches the oracle's greedy
                        // breaker exactly — a mid-word run boundary is never a line-break opportunity (§ CSS Text:
                        // no break within a word), and ONLY the unit's leading word is fit-tested against the band.
                        // The collapsed space lands on the line as a fragment of ITS run — a whitespace-only inline in
                        // a larger font grows the line it sits on (Chrome: 47 for `a<span style="font-size:40px"> </span>b`
                        // in a 16px block). The oracle grows it only where the space STAYS (a space the wrap drops
                        // grows nothing there; Chrome grows the line for any fragment on it — a shared gap, see the
                        // native_layout_text spec), so the growth is applied once the line the space sits on is settled.
                        let space_on_line = space_before && line_has_content;
                        if space_on_line {
                            line_x += sw; // hanging space (after preserved ones, under pre-wrap: all of them hang)
                            hang += sw;
                            if sw != 0.0 {
                                hang_pre = 0.0; // …a REAL space; the zero-width one is only an opportunity
                            }
                        }
                        // IN-WORD BREAKING (`overflow-wrap: break-word|anywhere` / `word-break: break-all`): a word
                        // WIDER THAN THE BAND may break between characters (a word that fits the band stays atomic
                        // and takes the normal path below, so it only ever soft-wraps as a whole). `wrap_mode` rides
                        // the run's otherwise-unused `metric` slot: 1 = break-all (fill the current line), 2 =
                        // break-word / 3 = anywhere (the over-long word moves to a FRESH line first, then breaks —
                        // alike in the flow; they differ only for the min-content measure, `text_intrinsic`).
                        // A WIDE character takes the same loop by a different door (below), so this is
                        // `charUnits` either way — one unit per code point under a per-character mode, wide
                        // characters as units of their own otherwise.
                        let wrap_mode = run.metric as u8;
                        // A word holding a WIDE character always breaks into units — it is not a question of
                        // room, the character IS the opportunity — where an in-word Latin break is offered only
                        // to a word too wide for the band. The two cannot both apply: the oracle's `anywhere`
                        // is `!wide && breaksAnywhere(el)`, so a wide word takes wide units, not per-character
                        // ones, and never the fresh line `break-word` moves an over-long word to.
                        let has_wide = run_has_wide && text[start..i].iter().any(|&u| is_wide_unit(u));
                        // …and a HYPHEN or dash inside the word is an opportunity of its own, whatever the room
                        // (§UAX #14): `well-known` is two PIECES wherever it sits, so the word takes the unit
                        // loop below and each piece is fit-tested against the room that is left — which is how a
                        // hyphenated word breaks at its hyphen instead of moving whole. Not under `nowrap`, which
                        // soft-wraps nowhere.
                        // (`hyphen_breaks_after` can only be true where the word holds a dash, so the cheap scan
                        // is a fast path over the same question, not a second condition.)
                        let word_hyphen = run_has_hyphen
                            && text[start..i].iter().any(|&u| is_hyphen_unit(u))
                            && (start..i).any(|k| hyphen_breaks_after(text, k, i));
                        // The band this word's units are cut against — `None` where the word has no units at
                        // all, which is most words and skips the float-list walk `band_w` does. (Not under an
                        // in-word mode: a container that declares one — `wrapRulesOf` names Discourse's `.cooked`
                        // and Forem's article body — asks the band of every word, as it did before this was a
                        // question at all.) Read ONCE for the whole word as the oracle reads it (`breakUnits(
                        // token, owner, lineRight - lineLeft)`); the line's own fit tests below stay live,
                        // following the band down past a float the word drops below.
                        let split_band = (!no_wrap && (has_wide || word_hyphen || wrap_mode != 0))
                            .then(|| band_w(total))
                            .filter(|&a| has_wide || word_hyphen || width > a + LINE_FIT_EPS);
                        if let Some(avail) = split_band {
                            // The over-long word's break opportunity before it (a space / atomic) is what `first`
                            // and the loop's fit tests act on; capture it before the fresh-line break clears the
                            // line, so `atomic_break` need only be consumed once, after the word is placed.
                            let preceded = space_breaks || atomic_break || ends_open;
                            // The space before the word stays on the line it hangs from — unless a fresh line is
                            // taken below before anything is placed, which drops it with the line it closes.
                            let mut space_pending = space_on_line;
                            let mut u = start;
                            let mut first = true;
                            while u < i {
                                // The word's next HYPHEN PIECE — `well-`, then `known`; the whole word where no
                                // hyphen cuts it. The PIECE is what the fit question is asked of: a per-character
                                // mode cuts inside one only where that piece alone does not fit the band, which is
                                // how `super-cali-fragilistic` breaks at its hyphens and only `fragilistic` breaks
                                // between characters (the oracle's `charUnits(piece, el, avail)`).
                                let pend = if word_hyphen { hyphen_piece_end(text, u, i) } else { i };
                                let piece_wide = has_wide && text[u..pend].iter().any(|&c| is_wide_unit(c));
                                let piece_w = if u == start && pend == i { width } else { measure_word(run, &text[u..pend])? };
                                let per_char = wrap_mode != 0 && !piece_wide && piece_w > avail + LINE_FIT_EPS;
                                // break-word / anywhere first move a piece they must cut to a fresh line, where a
                                // break opportunity sits — exactly the normal break-before condition, which the
                                // over-long piece always satisfies. break-all takes no fresh line: it fills the
                                // line it is on.
                                if per_char && wrap_mode >= 2 && line_has_content && (!first || preceded) {
                                    soft_break!();
                                    space_pending = false; // dropped with the line it closed
                                }
                                while u < pend {
                                    let ulen = break_unit_len(text, u, pend, per_char);
                                    let cw = measure_word(run, &text[u..u + ulen])?;
                                    let ow_now: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                                    // A unit boundary is always an opportunity (`u > start`); the first unit breaks only
                                    // where one already preceded the word (a space / atomic / line start) — the oracle's
                                    // `mayBreak = u > 0 || textMayBreak()`.
                                    let may_break = !first || preceded || !line_has_content || is_wide_unit(text[u]);
                                    let broke = line_has_content && may_break && line_x + ow_now + cw > band_w(total) + LINE_FIT_EPS;
                                    if broke {
                                        soft_break!();
                                    }
                                    // The pending space's line is settled only once the first unit is placed on it or
                                    // wraps away from it: a space the wrap DROPS grows nothing (the oracle), so the
                                    // metrics are applied after the break test, never before it.
                                    if space_pending {
                                        if !broke {
                                            line_asc = line_asc.max(sasc);
                                            line_desc = line_desc.max(sdesc);
                                        }
                                        space_pending = false;
                                    }
                                    // An empty line still too narrow for even one character drops below the float.
                                    if !floats.is_empty() && !line_has_content && cw + ow_now > band_w(total) + LINE_FIT_EPS {
                                        let fy = top + total;
                                        let at = float_fit_y(floats, fy, cw + ow_now + indent_now.get(), cl, cr, strut_lh);
                                        if at > fy {
                                            total += at - fy;
                                        }
                                    }
                                    settle_pending_oofs!();
                                    for o in open.iter_mut() {
                                        if !o.1 {
                                            line_x += o.0;
                                            o.1 = true;
                                        }
                                    }
                                    line_x += cw;
                                    hang = 0.0;
                                    hang_pre = 0.0;
                                    line_asc = line_asc.max(run.asc);
                                    line_desc = line_desc.max(run.line_height - run.asc);
                                    line_has_content = true;
                                    first = false;
                                    u += ulen;
                                }
                            }
                            atomic_break = false; // consumed the after-atomic break opportunity
                            ends_open = ends_with_break(text[i - 1]); // …and this word may leave one behind
                        } else {
                            let ow: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                            // A break opportunity precedes this word at a collapsed space OR right after an atomic —
                            // but `white-space: nowrap` never SOFT-wraps (only <br>), so the line grows past the band.
                            let mut broke = false;
                            // (No `is_wide_unit(text[start])` here: under a wrapping mode a wide-bearing word took
                            // the unit loop above, and under `nowrap` — the one way one reaches this branch — the
                            // line never soft-wraps at all, so the whole test is moot.)
                            let may_break = space_breaks || atomic_break || ends_open;
                            if !no_wrap && line_has_content && may_break && line_x + ow + width > band_w(total) + LINE_FIT_EPS {
                                soft_break!(); // break: close the line (the hanging space is dropped)
                                broke = true;
                            }
                            // An empty line whose first word won't fit the band drops below the float squeezing
                            // it (§9.5, "if a shortened line box is too small…"), growing the block by the gap. A
                            // `nowrap` line is NOT shortened by a float and never drops — it overlaps it on one line
                            // (the oracle does no float handling for a nowrap block), so skip this too.
                            if !no_wrap && !floats.is_empty() && !line_has_content && width + ow > band_w(total) + LINE_FIT_EPS {
                                let fy = top + total;
                                let at = float_fit_y(floats, fy, width + ow + indent_now.get(), cl, cr, strut_lh);
                                if at > fy {
                                    total += at - fy;
                                }
                            }
                            // Flush the still-open edges onto this line (once), then place the word.
                            settle_pending_oofs!();
                            for o in open.iter_mut() {
                                if !o.1 {
                                    line_x += o.0;
                                    o.1 = true;
                                }
                            }
                            line_x += width;
                            hang = 0.0;
                            hang_pre = 0.0;
                            line_asc = line_asc.max(run.asc);
                            line_desc = line_desc.max(run.line_height - run.asc);
                            line_has_content = true;
                            atomic_break = false; // consumed the after-atomic break opportunity
                            // …and this word leaves one behind when it ENDS in a wide character or a dash.
                            ends_open = ends_with_break(text[i - 1]);
                            if space_on_line && !broke {
                                line_asc = line_asc.max(sasc); // the space stayed: its run's metrics grow the line
                                line_desc = line_desc.max(sdesc);
                            }
                        }
                    }
                }
            }
            RUN_ATOMIC => {
                // A single box on the line — placed like an unbreakable word of width `metric`, growing the
                // line box by its own ascent / descent. An atomic is a break opportunity on BOTH sides
                // regardless of whitespace: it may break BEFORE it here (unconditional, on overflow), and it
                // sets `atomic_break` so the NEXT box may break before itself too.
                let width = run.metric;
                // An atomic is a break opportunity on both sides — but a space that is NOT one does not
                // become one by having an atomic after it: the oracle leaves `barrier = 'hard'` behind a
                // non-wrapping run's trailing space and hands that to the atomic as `decided`.
                let (space_before, sw, sasc, sdesc, space_breaks) = match pending_space.take() {
                    Some((s, a, d, b)) => (true, s, a, d, b),
                    None => (false, 0.0, 0.0, 0.0, false),
                };
                let space_is_hard = space_before && !space_breaks;
                let space_on_line = space_before && line_has_content;
                let mut broke = false;
                if space_on_line {
                    line_x += sw; // hanging space
                    hang += sw;
                    if sw != 0.0 {
                        hang_pre = 0.0; // …a REAL space; the zero-width one is only an opportunity
                    }
                }
                let ow: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                // An atomic is a break opportunity before it (§ line breaking) — but not under `white-space:
                // nowrap`, which never soft-wraps.
                // …and whether one may fall here is ONE question, and no `white-space` mode is part of it: the
                // oracle hands the atomic `placeOnLine(need, 0, barrier === 'hard', …)`, whose break test is
                // `!decided && lineHasContent && overflows(…)`. An atomic is a break opportunity on both
                // sides; the only thing that takes that away is a HARD barrier, which is what a non-wrapping
                // run's trailing space leaves. Neither the atomic's own mode nor the block's is asked.
                let may_break_here = !space_is_hard;
                if may_break_here && line_has_content && line_x + ow + width > band_w(total) + LINE_FIT_EPS {
                    soft_break!(); // break before the atomic (drop any hanging space)
                    broke = true;
                }
                if space_on_line && !broke {
                    line_asc = line_asc.max(sasc); // the space stayed: its run's metrics grow the line
                    line_desc = line_desc.max(sdesc);
                }
                // A nowrap line is not shortened by / dropped below a float — the BLOCK's mode, that is: a
                // non-wrapping RUN does drop, as one whole unit, which the pre-pass at the head of the text
                // arm does for it.
                if may_break_here && !floats.is_empty() && !line_has_content && width + ow > band_w(total) + LINE_FIT_EPS {
                    let fy = top + total;
                    let at = float_fit_y(floats, fy, width + ow + indent_now.get(), cl, cr, strut_lh);
                    if at > fy {
                        total += at - fy;
                    }
                }
                settle_pending_oofs!();
                for o in open.iter_mut() {
                    if !o.1 {
                        line_x += o.0;
                        o.1 = true;
                    }
                }
                line_atomics.push((ri, band_l(total) + line_x)); // its margin box starts here on this line
                line_x += width + run.size; // …and a grown flex container's growth moves the pen, not the break
                hang = 0.0;
                hang_pre = 0.0;
                line_asc = line_asc.max(run.asc);
                line_desc = line_desc.max(run.line_height - run.asc);
                line_has_content = true;
                atomic_break = true; // a break opportunity follows this atomic
            }
            RUN_OOF => {
                // §4.1: it neither sizes nor shifts the line. `font` carries its record index (the walk's
                // marker), and what is wanted is only WHERE the flow had reached: this x on this line. A line
                // that holds nothing else is still a line the flow reached — `line_has_content` is untouched,
                // so an empty block keeps its zero height and the marker settles at the line that never opens
                // (top 0, x 0), which is what the oracle gives it.
                //
                // A collapsed space still PENDING is part of where the flow has reached — the oracle puts the
                // box after it (`hello ` + an abspos is x = 35.99, not 31.99) — so its width counts here. It is
                // only PEEKED: the space has not been placed, and the next real content still places it (and
                // may still wrap away from it), which an out-of-flow box neither prevents nor consumes.
                //
                // An inline axis running from the RIGHT has no cursor to read at all: its static corner is the
                // content's right edge less the box (`staticCornerFor`), so the position is final the moment it
                // is taken — nothing on the line, and no alignment shift, moves it. `place_out_of_flow` reads
                // this the same way block flow's rtl static does (the content's far edge, the box subtracted
                // once its width is known), so what is recorded here is that edge.
                //
                // `size` / `ls` carry the `position: relative` offset of the inline boxes around it, which
                // moves the content this position is a reading of (§9.4.3) and so moves the reading too.
                let (ci, rx, ry) = (run.font as usize, run.size, run.ls);
                // The inline box it sits DIRECTLY in, if that box has an opening edge of its own (`metric`,
                // set by the walk) and the edges around it have not been placed — asked of their SUM, as the
                // flush is, so a pair that CANCELS is never "unplaced" to wait for — has not told the flow
                // where it reaches: the
                // edge goes down when the box's first content does, which may be a later line than this one.
                // Wait for it, keeping the cursor as the fallback for an edge that never lands. An edge further
                // OUT is not waited on — the oracle asks only `openInlines[openInlines.length - 1]`, so a plain
                // inner inline reads the cursor however edged the boxes around it are.
                let unplaced: f64 = open.iter().filter(|o| !o.1).map(|o| o.0).sum();
                if run.metric != 0.0 && unplaced != 0.0 && open.last().is_some_and(|o| !o.1) {
                    // `open.len()` is its own inline's depth: the walk only sets `metric` where that inline
                    // emitted a non-zero opening edge, so it is the innermost open box right now.
                    let pending_w = pending_space.map_or(0.0, |(w, _, _, _)| w);
                    pending_oofs.push((ci, rx, ry, open.len(), line_x + pending_w, line_no));
                } else if rtl {
                    oofs.push((ci, content_w + rx, total + ry));
                } else {
                    let pending_w = pending_space.map_or(0.0, |(w, _, _, _)| w);
                    line_oofs.push((ci, band_l(total) + line_x + pending_w + rx, total + ry));
                }
            }
            RUN_WBR => {
                // `<wbr>`: a zero-width soft-wrap opportunity — exactly the oracle's `barrier = null`, the same
                // thing it sets after an atomic inline. So carry it on `atomic_break` (the after-atomic break
                // flag) rather than the `pending_space` slot: the next box may break before it, yet a collapsible
                // space that immediately FOLLOWS still installs its own advance (a phantom width-0 pending space
                // would suppress that space's width). Under `nowrap` the break-before tests ignore the flag.
                atomic_break = true;
                // …and it OVERWRITES what stood there, a non-wrapping run's hard space included: the oracle
                // keeps ONE `barrier` and a `<wbr>` sets it to `null` outright. Without this the atomic arm's
                // `!space_is_hard` veto cancelled the opportunity the `<wbr>` had just installed.
                if let Some((w, a, d, _)) = pending_space {
                    pending_space = Some((w, a, d, true));
                }
            }
            _ => return None, // unknown run kind
        }
    }

    if line_has_content {
        close_line!(false); // close the final line (a trailing <br>'s fresh empty line is NOT closed)
    }
    // An opening edge that never landed (its inline closed holding nothing the flow placed) leaves the cursor
    // read at the marker standing, which is what `pendingStatic` falls back to when the inline has no fragment.
    // Believed UNREACHABLE: the walk admits an edged inline only with real content in it, and every placement
    // of real content settles first. Kept because the alternative to a wrong answer here is no answer at all —
    // and if it ever does fire, note that the oracle's own fallback is still moved by the line's alignment
    // (`lineStatics`), which this is not.
    for (ci, rx, ry, _, at, was) in pending_oofs.drain(..) {
        let x = if rtl {
            content_w + rx
        } else {
            band_l(total) + rx + if was == line_no { at } else { 0.0 }
        };
        oofs.push((ci, x, total + ry));
    }
    // …and a line that never OPENED never closed, so the markers on it are still waiting: a block whose only
    // children are out-of-flow has no content to close a line with, and the cursor those boxes read is the one
    // an empty line starts at — the indent, the band a float leaves. No line means no alignment, either (the
    // oracle's `alignLine` runs at a close that does not happen here), so they settle where they stand.
    for (ci, x, y) in line_oofs.drain(..) {
        oofs.push((ci, x, y));
    }
    Some(LineLayout { height: total, first: first_line, last: last_line, atomics, oofs })
}
// What `line_layout` lays out: the line count, the content height, and the first / last line as (top, ascent)
// within the content box — the baselines a box hands its container.
struct LineLayout {
    height: f64,
    first: Option<(f64, f64)>,
    last: Option<(f64, f64)>,
    // Where each ATOMIC run landed: (run index, x of its margin box from the content edge — its float band and
    // the line's alignment applied — the line's top, the line's ascent): the text arm drops a natively laid-out
    // atomic onto its line's baseline from these.
    atomics: Vec<(usize, f64, f64, f64)>,
    // Where each OUT-OF-FLOW marker's flow position fell: (record index, x from the content edge, line top).
    // `place_out_of_flow` reads it as the static corner, exactly as block flow's cursor is read.
    oofs: Vec<(usize, f64, f64)>,
}

// `\p{L}\p{N}`, which is how the oracle's `HYPHEN_BREAK_RE` spells its classes — read from that same regex
// (`unicode.rs` parses it), never from Rust std. The Unicode tables in this process disagree and move
// independently: rustc's `char::is_alphabetic` knows 4662 code points this V8 does not, and
// `char::is_alphanumeric` is Alphabetic ∪ N, which reads a COMBINING MARK as a letter where the regex does
// not. Either one MOVES BOXES — `abab-\u{93E}cdcd` and `abab-\u{A7F1}cdcd` break after the hyphen in native
// and not in the oracle — and with Rust std the answer moved with the toolchain the build happened to use.
fn letter_or_number(c: char) -> bool {
    let cp = c as u32;
    crate::unicode::is_letter(cp) || crate::unicode::is_number(cp)
}
// Is there a line-break opportunity BETWEEN `text[i]` and `text[i + 1]`, because of a hyphen or dash? UAX #14
// as Chrome applies it, and as `HYPHEN_BREAK_RE` spells it: a hyphen, figure dash or en dash breaks AFTER
// itself when it joins two words (or opens one, as in `-leading`), and an EM DASH breaks on both sides.
fn hyphen_breaks_after(text: &[u16], i: usize, end: usize) -> bool {
    const EM_DASH: u16 = 0x2014;
    let dash = |u: u16| matches!(u, 0x2D | 0x2010 | 0x2012 | 0x2013);
    if i + 1 >= end {
        return false;
    }
    let (here, next) = (text[i], text[i + 1]);
    if here == EM_DASH || next == EM_DASH {
        return true;
    }
    if !dash(here) {
        return false;
    }
    // The regex's classes are asked of CODE POINTS, so an astral letter (`ab-𝔘`) has to be decoded out of its
    // surrogate pair to be one: reading the lone surrogate says "not a letter" and loses the break.
    let after = cp_forward(text, i + 1, end);
    let before = cp_back(text, i);
    let letter_num = |c: Option<char>| c.is_some_and(letter_or_number);
    let joins_before = letter_num(before) || matches!(before, Some('-' | '\u{2010}'));
    if joins_before {
        return letter_num(after) || matches!(after, Some('-' | '"' | '(' | '\u{A0}'));
    }
    // …and one that opens a word instead: `-leading` breaks after the hyphen, `2-3` does not (the arm above
    // already took that one). `\p{L}` alone here, as the regex has it.
    after.is_some_and(|c| crate::unicode::is_letter(c as u32) || c == '-')
}
// The code point that STARTS at `i` (a surrogate pair decoded, a lone surrogate `None`), and the one that ENDS
// just before `i`.
fn cp_forward(text: &[u16], i: usize, end: usize) -> Option<char> {
    let u = *text.get(i)?;
    if (0xD800..=0xDBFF).contains(&u) && i + 1 < end {
        return char::decode_utf16([u, text[i + 1]]).next()?.ok();
    }
    char::from_u32(u as u32)
}
fn cp_back(text: &[u16], i: usize) -> Option<char> {
    let u = *text.get(i.checked_sub(1)?)?;
    if (0xDC00..=0xDFFF).contains(&u) {
        // …only where a HIGH one really precedes it: `decode_utf16` yields the leading unit's own `Ok` for an
        // unpaired low surrogate, which would answer with the character BEFORE it.
        let lead = *text.get(i.checked_sub(2)?)?;
        return if (0xD800..=0xDBFF).contains(&lead) { char::decode_utf16([lead, u]).next()?.ok() } else { None };
    }
    char::from_u32(u as u32)
}
fn is_hyphen_unit(u: u16) -> bool {
    matches!(u, 0x2D | 0x2010 | 0x2012 | 0x2013 | 0x2014)
}
// A text run ENDING in this unit leaves a break opportunity for whatever the next one starts with — the
// oracle's `endsWithBreak`: `BREAK_AFTER_RE` is a dash or a JS `\s`, and its other half is a wide character.
// JS `\s` is WIDER than the CSS white-space set, and that difference is why the units are named here at all:
// a U+00A0, U+000B, U+2009 or U+FEFF is not CSS white space, so none of them reaches native as a space run of
// its own — each stays inside the word, where only this test can see it. (Which is also why, of the
// `0x09..=0x0D | 0x20` block, only U+000B can ever be asked: the others end a word, so `is_ws_u16` cut it
// first.) Of those, Chrome breaks after none of U+00A0, U+2007, U+202F (GL in UAX #14), U+FEFF (WJ) or
// U+000B — which is no UAX #14 case at all: a vertical tab is neither CSS white space nor a segment break,
// just a character, so there is no opportunity beside it to begin with. Measured over all 25 of JS `\s`:
// those five and no others. The oracle's `\s` is therefore five characters too wide; native follows it for
// parity, and correcting BOTH engines is a backlog item, as with the run tokenisation in `appendText`.
fn ends_with_break(u: u16) -> bool {
    is_hyphen_unit(u)
        || is_wide_unit(u)
        || matches!(u, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}
// Where the HYPHEN PIECE starting at `u` ends: after the first hyphen the word may break at, which the piece
// keeps (`well-known` is `well-` then `known`), or at the word's end where there is none — the oracle's
// `hyphenPieces`. Only hyphens cut here: a wide character inside a piece is the unit loop's business, not this
// one's, so the two cuts compose the way `breakUnits` composes them.
fn hyphen_piece_end(text: &[u16], u: usize, end: usize) -> usize {
    (u..end).find(|&k| hyphen_breaks_after(text, k, end)).map_or(end, |k| k + 1)
}
// The next break UNIT at `u` in `text[..end]`, as the oracle's `charUnits` cuts one: a WIDE character is its
// own — which is what makes a Japanese paragraph wrap at all, having no spaces to break at — under `per_char`
// (`word-break: break-all`, `overflow-wrap: anywhere`) every code point is one, and otherwise a maximal run of
// non-wide characters is one unit. A surrogate pair is never split.
fn break_unit_len(text: &[u16], u: usize, end: usize, per_char: bool) -> usize {
    // A PAIRED high surrogate is two units; an unpaired one is a lone unit, exactly as `measure_run` slices it
    // (a disagreement there would measure a slice the break did not cut).
    let cp_len = |i: usize| {
        let paired = (0xD800u16..=0xDBFF).contains(&text[i])
            && i + 1 < end
            && (0xDC00u16..=0xDFFF).contains(&text[i + 1]);
        if paired { 2 } else { 1 }
    };
    let first = cp_len(u);
    if per_char || is_wide_unit(text[u]) {
        return first;
    }
    let mut n = first;
    while u + n < end && !is_wide_unit(text[u + n]) {
        n += cp_len(u + n);
    }
    n
}
// A UTF-16 unit whose code point is a WIDE character, and so a break unit of its own. One definition, shared
// with the metrics (`font::is_wide_char`): a second copy drifted once already — it counted a high surrogate as
// wide, which made every astral emoji its own break unit and split a ZWJ sequence into three full-em glyphs,
// where the oracle's `isWideChar` is BMP-only.
fn is_wide_unit(u: u16) -> bool {
    crate::font::is_wide_char(u as u32)
}

// The FLOAT CONTEXT of one block formatting context (§9.5): the margin boxes of the floats placed in
// it so far, in the OWNER's border-box frame (the frame `measure(owner)` lays its children in). A float
// never crosses a `starts_bfc` boundary, so each such block gets a fresh, empty context. `side` is
// FLOAT_LEFT / FLOAT_RIGHT.
//
// A float does cross every OTHER boundary: its containing block is its own parent, but the context it is
// recorded in — the one whose lines it shortens and whose `clear` it answers — is the nearest ancestor
// that establishes one, however many plain `<div>`s lie between (the everyday `.row > .col { float }`).
// Each block in between hands its children a fresh context of its own and `shifted`s what they leave in it
// into its own frame, so the rectangles arrive at the owner in the owner's frame however deep they started.
#[derive(Clone, Copy)]
struct FloatItem {
    side: u8,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}
impl FloatItem {
    // The same rectangle read in the frame one level up: the frame of a block that holds the box this
    // float was placed in. Every `measure` lays a subtree out relative to its own border box, so a float
    // that ESCAPES its parent (the parent establishes no context of its own) arrives in the parent's frame
    // and is shifted by where the parent itself landed.
    fn shifted(&self, dx: f64, dy: f64) -> FloatItem {
        FloatItem { side: self.side, left: self.left + dx, right: self.right + dx,
                    top: self.top + dy, bottom: self.bottom + dy }
    }
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
    // What this run would come to with `o` joined — asked where a box's position is wanted before the run
    // is actually advanced (a child that turns out to collapse through never joins it at all).
    fn peek(&self, o: CMargin) -> f64 {
        let mut c = *self;
        c.merge(o);
        c.value()
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
    imposed_h: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
    fc: &mut FloatCtx,
    // This node's border-box origin in the frame of the float context `fc` (its owner's border-box).
    // Used only by the text-block branch to place its lines around the floats; 0 when `fc` is empty.
    bfc_x: f64,
    bfc_y: f64,
) -> MInfo {
    let n = inputs[i].get().with_imposed_height(imposed_h);
    let content_top_rel = n.bt + n.pt;
    let content_w = n.content_w(w);
    // This box is its in-flow children's containing block: their percentage sizes resolve against its content
    // width and — where it is definite — its content height (a flex COLUMN's main size, floor included), which is
    // what the oracle hands `usedSize` for them. Resolved afresh on every measure, so a box measured again at
    // another width or under an imposed height hands them the box it has now.
    let pct_h_basis = if n.display == DISPLAY_FLEX && !n.flex_main_is_x { n.column_main() } else { n.definite_content_h().unwrap_or(f64::NAN) };
    for &c in &children[i] {
        let k = inputs[c].get();
        if k.has_percent_sizes() && k.out_of_flow == 0 {
            inputs[c].set(k.with_percent_sizes(content_w, pct_h_basis));
        }
    }

    // A REPLACED leaf: its box comes from its intrinsic size (`replaced_box`) — the width the caller resolved
    // through `used_width` (or a flex size), the height derived here; no children, no baseline of its own
    // (a container synthesises its bottom edge), margins that never adjoin.
    if n.replaced {
        // Its CONTENT height, when a flex column asks for it as the automatic minimum (MEASURE_AUTO_HEIGHT →
        // `item_auto_height`): an image, or a box with an intrinsic RATIO, has none of its own to hold (Chrome:
        // an img in a 20px column shrinks to 13.33); a ratio-less control keeps its intrinsic height (an input
        // stays 21) — `shrinks_to_nothing`, decided where the intrinsic size is.
        let (_, h) = if n.item_auto_height && n.shrinks_to_nothing { (0.0, 0.0) } else { replaced_box(&n, w) };
        boxes[i].nid = n.nid;
        boxes[i].w = w;
        boxes[i].h = h;
        boxes[i].auto_height = false;
        // The oracle asks a replaced box for its baseline through TWO functions that do not agree, so native
        // keeps the two answers apart. `boxBaselineOffset` — what a container's baseline scan takes from it —
        // gives the CHROME's baseline where the control draws text and NOTHING otherwise. `atomicBaselineOffset`
        // — what it hands the line it sits on — gives `controlBaseline` for any replaced box, which for one that
        // draws no text is its border-box bottom (a checkbox, a radio, a range, an image input, and every
        // non-control replaced box; only an `<img>` has none, and a box that SCROLLS is answered before this
        // — which is why a `<textarea>` gives none: it scrolls, not because it draws no text).
        let chrome = match n.control_baseline {
            1 => Some(n.pt + n.bt + ((h - n.edges_y()).max(0.0) - n.control_font_box) / 2.0 + n.control_font_asc),
            2 => Some((h - n.pb - n.bb).max(0.0)),
            _ => None,
        };
        boxes[i].first_baseline = chrome;
        boxes[i].last_baseline = chrome;
        // …including what a PARENT's inline-block baseline scan takes from this box, which is the same
        // `boxBaselineOffset` answer. The atomic's own contribution to its LINE is the other one, and only the
        // line site asks for it (see `line_layout`'s native-atomic loop).
        boxes[i].inline_block_baseline = chrome;
        let top = CMargin::of(Input::m(n.mt));
        return MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false };
    }

    // A flex container (§9.7): the item SIZING is resolved JS-side (each item's used main/cross size rides
    // its width/height); native does only the placement — main-axis distribution + cross-axis alignment.
    if n.display == DISPLAY_FLEX {
        return measure_flex(i, w, imposed_h, inputs, runs, run_texts, grids, children, boxes, failed);
    }

    // A TABLE (§17): native sizes the COLUMNS and the ROWS from the cells' own content, and positions every
    // cell / row / row-group and the table box.
    if n.display == DISPLAY_TABLE {
        return measure_table(i, w, imposed_h, inputs, runs, run_texts, grids, children, boxes, failed);
    }

    // A computed GRID (§12): native sizes the columns (fixed / % / fr / intrinsic) and lays out each item at its
    // track width; rows are content-height. The parsed template + gaps + placement live in `grids[grid_start..]`.
    // (A TABLE's own side-channel, `table_col_decls`, lives at the same index.)
    if n.display == DISPLAY_GRID {
        return measure_grid(i, w, imposed_h, inputs, runs, run_texts, grids, children, boxes, failed);
    }

    // A text block (inline formatting context): its content height is the greedy line layout over its
    // run sequence, measured natively (font.rs) with no per-run crossing. Its runs are
    // runs[run_start..run_start+run_count]; its only child records are the atomic inlines it lays out itself.
    // If it can't be measured (bad font / tab / combining / CJK / mixed-font word), flag the pass for JS.
    if n.display == DISPLAY_TEXT_BLOCK {
        // The block's content edges and top in the float context's (owner's) frame — the lines route
        // around any floats that overlap them. `fc.items` is empty for the ordinary text block, and then
        // line_layout uses the full content width (bit-identical to the no-float path).
        let cl = bfc_x + n.bl + n.pl;
        let cr = cl + content_w;
        let bfc_top = bfc_y + content_top_rel;
        let (rs, re) = (n.run_start.max(0) as usize, (n.run_start + n.run_count).max(0) as usize);
        let content_h = if re <= runs.len() && rs <= re {
            // An ATOMIC inline native lays out itself (its run names a child record): SHRINK-TO-FIT wide (its
            // intrinsic widths clamped to the block's content width — a ratio-only box takes the width less its
            // margins; a declared width wins), laid out at that width, hanging from its own inline-block baseline
            // (its bottom margin edge when it has no line, or scrolls) plus its top margin, raised by the baseline
            // SHIFT the run carries in `asc` — or, aligned against the parent's font box, where that alignment puts
            // its margin box: the oracle's `growAtomic` / `atomicBaselineOffset` / `alignedAscent`.
            // The settled margin box, ascent and outer height ride a copy of the run stream (taken only when
            // there is such an atomic), which `line_layout` places like any pushed atomic.
            let has_native_atomic = runs[rs..re].iter().any(|r| r.kind == RUN_ATOMIC && r.font >= 0);
            let mut owned: Vec<Run> = if has_native_atomic { runs[rs..re].to_vec() } else { Vec::new() };
            for r in owned.iter_mut() {
                if r.kind != RUN_ATOMIC || r.font < 0 {
                    continue;
                }
                let c = r.font as usize;
                let k = inputs[c].get();
                let (ml, mr, mt, mb) = (Input::m(k.ml), Input::m(k.mr), Input::m(k.mt), Input::m(k.mb));
                let auto_w = if k.replaced && k.ratio_only {
                    (content_w - ml - mr).max(0.0)
                } else if !is_auto(k.width) {
                    0.0 // a declared width discards it — and asking would walk a subtree for nothing (see place_out_of_flow)
                } else {
                    // …else it shrink-to-fits in the block's own content width (the oracle's inline-level path
                    // passes that as both the room and the percentage basis) — and an intrinsic-size KEYWORD takes
                    // the figure it names. (For min / max-content that is the figure the shrink-to-fit width was
                    // already pinned to; `fit-content` clamps that width again as the oracle's `usedSize` clamps its
                    // `autoW`, so the float steps are the oracle's too.)
                    let sized = shrink_to_fit_width(c, content_w, inputs, runs, run_texts, grids, children).and_then(|stf| {
                        if k.width_kw == 0 { Some(stf) } else { content_sized_width(c, stf, inputs, runs, run_texts, grids, children) }
                    });
                    match sized {
                        Some(w) => w,
                        None => {
                            failed.set(true);
                            0.0
                        }
                    }
                };
                let w = used_width(&k, auto_w);
                measure(c, w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                let h = boxes[c].h;
                // The oracle's `atomicBaselineOffset`: a box that SCROLLS has no baseline of its own (CSS Align
                // §9 reads one off its border box) except a button, which is a button however it scrolls —
                // and everything else hands over its own. A REPLACED box is not the exception it used to look
                // like: `inline_block_baseline` is already None for the ones that have none (an image, a
                // chromeless control) and the CHROME's baseline for the ones that do, which is what
                // `controlBaseline` gives the oracle. Refusing it here hung a text-drawing control from its
                // bottom margin edge and grew every line it sat on by its descent.
                let own = if k.scrolls_y && !k.is_button {
                    None
                } else if k.replaced {
                    // `atomicBaselineOffset` asks `controlBaseline` of ANY replaced box, which is its
                    // border-box bottom where the control draws no text (kind 4) — not the `None` that the
                    // box-scan answer carries for one. Only an `<img>` (kind 0) has no baseline at all.
                    match k.control_baseline {
                        0 => None,
                        4 => Some(boxes[c].h),
                        _ => boxes[c].inline_block_baseline,
                    }
                } else {
                    boxes[c].inline_block_baseline
                };
                // The run's `line_height` / `metric` slots arrive as the alignment code and the parent-font figure
                // it reads (`nlAtomicAlignment`), and leave as the box's outer height and advance.
                let outer = h + mt + mb;
                let parent_figure = r.metric;
                r.asc += match r.line_height as u8 {
                    VA_MIDDLE => outer / 2.0 + parent_figure,
                    VA_TEXT_TOP => parent_figure,
                    VA_TEXT_BOTTOM => outer - parent_figure,
                    VA_BASELINE_MIDDLE => outer / 2.0,
                    _ => mt + own.unwrap_or(h + mb),
                };
                r.metric = w + ml + mr;
                r.line_height = outer;
                // An auto-width WRAPPING flex container is then GROWN to what its own layout reached — its lines
                // can add up past the intrinsic figure (two columns of 50 and 80 make 130) — as the oracle's
                // atomic placement grows it from `_lbFlowRight`. After the line has decided where it breaks,
                // which the oracle decided on the width it reserved: the growth rides `size` (a slot no atomic
                // reads) and only moves the pen.
                if k.display == DISPLAY_FLEX && k.flex_wrap && is_auto(k.width) && k.width_kw == 0 {
                    let reach = flow_right(c, inputs, children, boxes);
                    if reach > boxes[c].w {
                        r.size = reach - boxes[c].w;
                        boxes[c].w = reach;
                    }
                }
            }
            let local: &[Run] = if has_native_atomic { &owned } else { &runs[rs..re] };
            match line_layout(local, &run_texts[rs..re], n.strut_lh, n.strut_asc, content_w, &fc.items, cl, cr, bfc_top, LineStyle {ws_mode: n.ws_mode, align: n.text_align, rtl: n.from_right(), indent: (n.indent_px, n.indent_hanging, n.indent_each_line, n.indent_spent)}) {
                Some(ll) => {
                    boxes[i].first_baseline = ll.first.map(|(top, asc)| content_top_rel + top + asc);
                    boxes[i].last_baseline = ll.last.map(|(top, asc)| content_top_rel + top + asc);
                    boxes[i].inline_block_baseline = boxes[i].last_baseline;
                    // Each native atomic drops from its line's top to where its own baseline meets the line's.
                    for (ri, x, top, line_asc) in ll.atomics {
                        let r = local[ri];
                        if r.font < 0 {
                            continue;
                        }
                        let c = r.font as usize;
                        let k = inputs[c].get();
                        boxes[c].x = n.bl + n.pl + x + Input::m(k.ml);
                        boxes[c].y = content_top_rel + top + (line_asc - r.asc) + Input::m(k.mt);
                    }
                    // …and each OUT-OF-FLOW child records its STATIC POSITION, which is what the flow would
                    // have given it: the inline offset it interrupted and the top of that line (measured off
                    // the oracle — after `hello ` on a 200px block it is x = 57.6, y = 0; wrapped onto the
                    // second line, x = 153.6, y = 22; under `text-align: right`, the aligned offset). Same
                    // contract as block flow's `(content_left_rel, cursor)`, which `place_out_of_flow` reads
                    // once every box is final.
                    for (ci, x, top) in ll.oofs {
                        boxes[ci].x = n.bl + n.pl + x;
                        boxes[ci].y = content_top_rel + top;
                    }
                    ll.height
                }
                None => {
                    failed.set(true);
                    0.0
                }
            }
        } else {
            failed.set(true);
            0.0
        };
        // An out-of-flow child the walk REPLAYED (its box is the oracle's, riding the record) is laid out at
        // that box and positioned by `place` from rec[39..40] — the same two lines block flow gives it. It has
        // no marker on any line (the walk emits none for it), so nothing here has touched it, and a text block
        // that never looked at its non-atomic children would have left it a 0x0 box at the origin. The record
        // says whether there is one, so a page whose text blocks hold none pays a bit read rather than a scan.
        if n.has_replayed_oof {
            for &c in &children[i] {
                let cn = inputs[c].get();
                if cn.out_of_flow != 0 && !cn.native_oof() {
                    let cw = resolve_width(&cn, content_w);
                    measure(c, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                    boxes[c].x = 0.0;
                    boxes[c].y = 0.0;
                }
            }
        }
        // What the lines alone came to — the auto height, and a table cell's `natural_h` (whose declared height
        // is a FLOOR the content grows past, §17.5.3).
        let flow_h = content_top_rel + content_h + n.pb + n.bb;
        let box_h = if is_auto(n.height) {
            flow_h
        } else if n.height_is_floor {
            flow_h.max(if n.border_box { n.height.max(n.edges_y()) } else { n.height + n.edges_y() })
        } else if n.border_box {
            n.height.max(n.edges_y())   // a border box is never smaller than its border+padding (content ≥ 0)
        } else {
            n.height + n.edges_y()
        };
        let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_y() };
        // A table CELL's min/max-height do not apply (measured: Chrome leaves a `min-height: 40px` cell at its
        // 20px line, and a `max-height: 5px` one uncapped) — its height is a floor and its row decides the rest.
        let box_h = if n.height_is_floor { box_h.max(0.0) } else { clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0) };
        boxes[i].nid = n.nid;
        boxes[i].w = w;
        boxes[i].h = box_h;
        boxes[i].natural_h = Some(flow_h);
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
    let bottom_open = !n.starts_bfc && n.bb == 0.0 && n.pb == 0.0 && n.bottom_adjoins;

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
    // The border-box width an in-flow block child takes in `avail` of inline room — which is the content
    // width, or the band a float narrows it to (`block_child_width`). Asked per branch, because each knows
    // its own room and because the shrink-to-fit arm walks the child's subtree.
    let width_in = |c: usize, avail: f64| {
        block_child_width(c, avail, inputs, runs, run_texts, grids, children, failed)
    };

    for &c in &children[i] {
        let cn = inputs[c].get();
        if cn.out_of_flow != 0 {
            // §4.1: an absolute/fixed child neither sizes nor shifts the flow. Positioned NATIVELY, it only records
            // its STATIC position here — where the flow has reached (the cursor, before any margin still open; the
            // content's right edge for an rtl flow) — and is sized and placed by `place_out_of_flow` once every
            // box is final. Replayed, its subtree is laid out at its pushed border box (in a fresh context — it
            // establishes a BFC) and its box reset to this block's origin; `place` then positions it by rel_x/rel_y
            // alone (el._lb − container._lb). Neither touches the cursor / margin / has_child state.
            if cn.native_oof() {
                // That cursor is a LINE cursor: it starts in the band a float leaves at this y — asked over a
                // LINE BOX's height, as `line_layout` asks it and as `retakeBand` does, so a float whose band
                // starts just below the cursor is not missed — and it carries the block's FIRST-LINE INDENT
                // until an in-flow child spends it (an out-of-flow box is not a child that does). An rtl flow
                // reads neither: its corner is the content's right edge.
                boxes[c].x = if n.from_right() {
                    content_left_rel + content_w
                } else {
                    let indent = if !has_child != n.indent_hanging { n.indent_px } else { 0.0 };
                    float_band(&ctx.items, cursor, n.strut_lh, cl, cr).0 + indent
                };
                boxes[c].y = cursor;
                continue;
            }
            let cw = resolve_width(&cn, content_w);
            measure(c, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            boxes[c].x = 0.0;
            boxes[c].y = 0.0;
            continue;
        }
        if cn.float_kind != 0 {
            // A FLOAT is placed where the flow has reached (top0) but does NOT advance the flow cursor and
            // never collapses margins (§9.5.1 / §8.3.1); the lines/blocks after it route around it instead.
            // Its subtree lays out in a fresh context (a float starts its own BFC).
            let top0 = cursor + pending.value();
            // §10.3.5: a float's AUTO width SHRINKS TO FIT where a block's fills — its min-content widened to
            // the room its containing block leaves it (its own margins off, as the oracle's `avail`), capped
            // at its max-content, and then through `used_width` for its min/max and the border-box floor like
            // any declared one. That is `block_child_width`'s own `fit-content` arm, and an intrinsic-size
            // KEYWORD on a float wants the same treatment as on any other box, so the one helper answers
            // both — reading only `is_auto` would send `width: max-content` down the fit-content path, which
            // is the same answer only while `intrinsic_widths_of` happens to PIN the keyword's figure (it
            // returns early for a table before that pin). The walk marks such a float a MEASURED subtree, so
            // a measure that fails is that gate having a hole rather than a shape to defer.
            let fw = if is_auto(cn.width) || cn.width_kw != 0 {
                let room = (content_w - Input::m(cn.ml) - Input::m(cn.mr)).max(0.0);
                match content_sized_width(c, room, inputs, runs, run_texts, grids, children) {
                    Some(w) => used_width(&cn, w),
                    None => {
                        failed.set(true);
                        0.0
                    }
                }
            } else {
                resolve_width(&cn, content_w)
            };
            measure(c, fw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
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
        // A DIRECT text-block child coexisting with floats routes its lines around them (§9.5). Its
        // collapsed top is deterministic (a text block never collapses through, top_only == of(mt)), so it
        // can be placed BEFORE measuring — which the narrowing needs, to know each line's flow position in
        // the owner frame. A CLEARED box and a box that starts its own context are placed by their own rules
        // below; a plain block container falls through to the general path, which lays it out in this
        // context read in its own frame.
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
                // …in a context of its OWN, for the same reason every other child gets one: what it leaves
                // there are the floats that ESCAPED it, and they are shifted into this block's frame once its
                // origin is settled. (Without that they were dropped — a float inside a cleared box vanished
                // from the context, and the next `clear` sibling cleared past nothing.)
                let mut sub = FloatCtx::new();
                let cm = measure(c, width_in(c, content_w), f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut sub, 0.0, 0.0);
                if cm.collapse_through {
                    // A THROUGH cleared box is placed by a different rule (§8.3.1: its own above-margin sits
                    // ON TOP of the clearance line, and it does not advance the flow) — defer to JS.
                    failed.set(true);
                } else {
                    // §8.3.1: a box that takes CLEARANCE does not collapse its top margin with its parent's —
                    // the clearance line replaces the margin rather than adding to it, and the parent is not
                    // moved by it at all (Chrome: a `clear: left; margin-top: 20px` FIRST child of a plain
                    // wrapper after a 5px float sits at 5, its margin spent, and the wrapper stays at 0 — where
                    // collapsing it out both moved the wrapper and left the child below its own float).
                    //
                    // WHETHER it takes clearance rides the RECORD: the walk answers it off the document — is
                    // there a float earlier in this box's formatting context — and not from the floats in
                    // hand. The two are the same question only for a block that can SEE every float in its
                    // context, and the measure that decides where a box goes is handed an empty one on
                    // purpose (it wants the margin, not the geometry), so answering from `ctx` made a box's
                    // margin depend on which measure asked. WHERE it lands is still the geometry's answer
                    // below, over the floats whose rectangles this pass actually has.
                    //
                    // Chrome asks the question two ways and this is one of them (measured, 153, ~80 shapes —
                    // the campaign memory has the matrix): a float placed while this block was laid out
                    // separates whatever its geometry, an INHERITED one only where it reaches below the box.
                    // Reading the second like the first is a bounded gap both engines share on purpose: it is
                    // the answer they can both give, and making it geometric means making the oracle's margin
                    // HOIST geometric, which runs before a single float is placed.
                    let y0 = if first && top_open {
                        if !cn.takes_clearance {
                            top_m.merge(cm.top);
                        }
                        content_top_rel
                    } else {
                        pending.merge(cm.top_only);
                        cursor + pending.value()
                    };
                    let y = clearance_y(&ctx.items, y0, cn.clear);
                    if y >= floats_bottom(&ctx.items) {
                        // Past every float, so its band is the whole content width — which is what the
                        // oracle's own `band == null` gives it, auto margins and legacy alignment included.
                        boxes[c].x =
                            block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, boxes[c].w);
                        boxes[c].y = y;
                        let (dx, dy) = (boxes[c].x, boxes[c].y);
                        ctx.items.extend(sub.items.iter().map(|f| f.shifted(dx, dy)));
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
                let cw = width_in(c, (br0 - bl0).max(0.0));
                let cm = measure(c, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                let outer = boxes[c].w + ml + mr;
                let (y, bl, br) = if outer > br0 - bl0 {
                    let yy = float_fit_y(&ctx.items, cy, outer, cl, cr, boxes[c].h);
                    let (l, r) = float_band(&ctx.items, yy, boxes[c].h.max(1.0), cl, cr);
                    (yy, l, r)
                } else {
                    (cy, bl0, br0)
                };
                boxes[c].x = block_child_x(&n, &cn, bl, br, boxes[c].w);
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
                let child_w = width_in(c, content_w);
                let cx = block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, child_w);
                boxes[c].x = cx;
                boxes[c].y = cy;
                let cm = measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, ctx, cx, cy);
                cursor = cy + boxes[c].h;
                pending = cm.bottom;
                all_children_through = false;
                has_child = true;
                first = false;
                continue;
            }
            // …and a plain BLOCK CONTAINER beside a float falls through to the general path: §9.5 leaves it
            // its full width and lets the float OVERLAP it — only the lines inside it route around the float —
            // so all it needs is this block's context, read in its own frame.
        }
        has_child = true;
        // WHERE the child lands, and in WHICH context it is laid out, are one question: the floats of this
        // block reach into it in ITS frame (§9.5 leaves a block container its full width and lets a float
        // OVERLAP it — it is the LINES inside that route around the float), and its frame is where the flow
        // puts it. Under an OPEN top edge the FIRST in-flow child answers that for free: it sits at the
        // content top whatever its margin comes to, because the margin is hoisted into this block's own.
        // Anywhere else the position is the collapsed run, which folds in margins only the subtree knows —
        // so the child is measured once in an EMPTY context to learn them, and (where this block holds
        // floats at all) again in the context read in its own frame.
        //
        // Asked of the CONTEXT, never of the child's own top: a descendant pulled ABOVE that top by a
        // negative margin meets floats the child's border box never reaches (a `margin-top:-40px` pull-up
        // under a box starting below the float laid its text out full width where Chrome wraps it round).
        // Measured, native alone: one 1px float in a block costs ~3x over an 8191-node subtree under it
        // (+6% of a whole shadow pass, which the JS walk dominates), ~2.5x on a page-shaped one. The factor
        // grows with nesting DEPTH, not with how far the float reaches — a translated context stays
        // non-empty all the way down, and a 1px float measures the same as a 3000px one — but only through
        // NON-first children: a chain of first children under open top edges needs no probe at all and
        // stays at ~1.4x however deep it runs. A block whose context holds no float — every block on a
        // float-free page — pays one `Vec::is_empty` and is measured once.
        let child_w = width_in(c, content_w);
        let mut sub = FloatCtx::new();
        // The throwaway measure: only a position comes out of it, and only where one isn't known already.
        let probe = if first && top_open {
            None
        } else {
            Some(measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut sub, 0.0, 0.0))
        };
        let cy = match &probe {
            None => content_top_rel,
            Some(p) => cursor + pending.peek(p.top_only),
        };
        // In an rtl block the in-flow children start at the RIGHT content edge (r1): the child's own right
        // edge sits at content_right - margin_right, so its left is that minus its width. A block that fills
        // the width lands back at content_left + margin_left, so this covers both.
        let cx = block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, child_w);
        let cm = if !ctx.items.is_empty() {
            let mut inner = FloatCtx { items: ctx.items.iter().map(|f| f.shifted(-cx, -cy)).collect() };
            let placed = inner.items.len();
            let cm2 = measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut inner, 0.0, 0.0);
            // The floats were translated to the position the probe's margin gave the box; if this measure
            // would put it anywhere else, that translation is stale and so is everything laid out against it.
            // A BACKSTOP, and deliberately so: a margin that depends on the floats around it is the thing
            // this design cannot have, and the one case that produced one — a cleared descendant, whose
            // margin the clear arm dropped only when the floats were in hand — was fixed at the source by
            // putting that answer on the record. Nothing known reaches this now; it stays because the
            // alternative to a decline here is a box laid out against a frame nobody believes.
            // It compares the POSITION rather than the margins on purpose: a run joins `pos` and `neg`
            // independently, so two different margin sets can share a value and still place the box
            // differently — reading `CMargin::value()` here was 10px of silent wrongness.
            if let Some(p) = probe {
                let cy2 = cursor + pending.peek(cm2.top_only);
                if cm2.collapse_through != p.collapse_through || (cy2 - cy).abs() > 0.01 {
                    failed.set(true);
                }
            }
            sub.items = inner.items.split_off(placed);
            cm2
        } else {
            match probe {
                Some(p) => p,
                // The first child under an open top edge, with no float in the context: nothing was measured
                // for the position, so this is its one measure.
                None => measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut sub, 0.0, 0.0),
            }
        };
        // A box whose used width the measure settled for itself (a replaced leaf) would be placed against a
        // stale one — everything that reaches here with floats around it is a plain block container, whose
        // width is the one it was given, and this says so rather than assuming it.
        if boxes[c].w != child_w {
            boxes[c].x = block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, boxes[c].w);
            if !ctx.items.is_empty() {
                failed.set(true);
            }
        } else {
            boxes[c].x = cx;
        }
        // A child that collapses THROUGH an open top edge leaves the run in this block's own top margin and
        // does not push the next sibling with it — which is also why the escaped floats below cannot wait for
        // the end of the loop body: this arm leaves it early.
        let hoisted_through = first && top_open && cm.collapse_through;
        if !cm.collapse_through {
            all_children_through = false;
        }
        if first && top_open {
            // The first in-flow child's top margin collapses with this node's top margin (collapse-
            // through the open top edge): it propagates up, and the child sits AT the content top —
            // unless CLEARANCE separates the two (§8.3.1), which the record answers structurally, so that
            // this measure and the one the float paths take agree about a box whose float neither of them
            // can see. The margin is then no part of this block's own, and the clear arm above is where a
            // float actually in this context pulls the box down past it.
            if !cn.takes_clearance {
                top_m.merge(cm.top);
            }
            boxes[c].y = content_top_rel;
            if cm.collapse_through {
                // …and a child that collapses THROUGH leaves the run where it put it — in the parent's own
                // top margin — without also pushing the next sibling with it, which counted it twice (a
                // `margin: 20px 0` empty box followed by a `margin: 15px 0` one put the second at 40 where
                // Chrome and the oracle say 20). The next sibling is still the FIRST whose top joins the
                // parent's, exactly as the oracle's `topOnly` loop keeps joining while children come back
                // through: leave `first` alone and `pending` empty.
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
        // …and now the child's origin is known, so what escaped it can be read in this block's frame.
        let (dx, dy) = (boxes[c].x, boxes[c].y);
        ctx.items.extend(sub.items.iter().map(|f| f.shifted(dx, dy)));
        if !hoisted_through {
            first = false;
        }
    }

    // The block's baselines: the first / last in-flow, non-floated child that has one (`baselineCandidates`).
    let (fb, lb, ib) = child_baselines(children[i].iter().copied(), inputs, boxes);
    boxes[i].first_baseline = fb;
    boxes[i].last_baseline = lb;
    boxes[i].inline_block_baseline = ib;

    let mut bottom_m = CMargin::of(Input::m(n.mb));
    // What the flow alone came to: the auto height, and every box's `natural_h` (only a table cell reads it).
    let flow_h = if is_auto(n.height) || n.height_is_floor {
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
        // The CONTENT height is what floors at zero — a net-negative run of collapse-through children can
        // leave the flow ABOVE the content top, and the block is then zero-content-tall, not zero-tall: its
        // own padding and borders still take their room (`grown` in the oracle).
        content_top_rel + (flow_bottom.max(floats_to) - content_top_rel).max(0.0) + n.pb + n.bb
    } else {
        f64::NAN
    };
    let box_h = if is_auto(n.height) {
        flow_h
    } else if n.height_is_floor {
        // A TABLE CELL: the declared height is a floor the content grows past (§17.5.3).
        flow_h.max(if n.border_box { n.height.max(n.edges_y()) } else { n.height + n.edges_y() })
    } else if n.border_box {
        n.height.max(n.edges_y())   // a border box is never smaller than its border+padding (content box ≥ 0)
    } else {
        n.height + n.edges_y()
    };
    let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_y() };
    // A table CELL's min/max-height do not apply (see the text arm) — its height is a floor, its row decides.
    let box_h = if n.height_is_floor { box_h.max(0.0) } else { clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0) };

    boxes[i].nid = n.nid;
    boxes[i].w = w;
    boxes[i].h = box_h;
    boxes[i].auto_height = is_auto(n.height);
    boxes[i].natural_h = if flow_h.is_nan() { None } else { Some(flow_h) };

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

// Native flex PLACEMENT for a `row` OR `column` (§9.7), nowrap or wrap, main axis forward or reversed, in any
// writing mode — `flex_main_is_x` is the PLAN's answer (`flexAxisPlan`), so a vertical row arrives here as a
// main-Y layout and needs no mode of its own.
// The item SIZING is resolved JS-side — each item's used main and cross size rides its record (width/height,
// swapped by `flex_main_is_x`), like a float's shrink-to-fit width — so this only DISTRIBUTES the items on
// the MAIN axis (justify-content + gap + main-axis auto margins) and ALIGNS them on the CROSS axis
// (align-items/self + cross-axis auto margins), then sizes the container's own box (clamping a ROW's box
// height by min/max-height — two-phase, so an auto-height row's items stay content-aligned). Each item's
// subtree is laid out by the ordinary `measure` at its pushed border-box, in
// a fresh float context (an item is its own formatting context). Mirrors layoutFlexRow / layoutFlexColumn /
// stackFlexLines / crossAlignPhysical / autoMarginSplit. The harness bails a cross axis running bottom→top,
// one running right→left that also wraps or carries a cross auto margin, wrap-reverse, `position: sticky`, a
// WRAPPING auto-height column with a max-height, unsupported-nested-flex and replaced.
// CSS Flexbox §9.7, "resolve the flexible lengths" — the oracle's `resolveFlexibleLengths`: the line's free
// space goes to (or comes from) the items in proportion to their factors, each result clamped by that item's
// own minimum and maximum (`clamp_of`). Which way the line flexes is decided ONCE, from the HYPOTHETICAL sizes
// (each base already clamped). An item that cannot flex that way, or whose base already violates its clamp in
// that direction, is frozen at its hypothetical size; §9.7.4's scaled shrink factor weights by the INNER base;
// factors summing below 1 hand out only that fraction of the INITIAL free space; after each round the items
// that violated in the direction of the total violation freeze and the rest flex again against what those
// gave up. An indefinite main size (`available` None — an auto-height column) has no free space either way.
fn resolve_flexible_lengths(bases: &[f64], inner: &[f64], grow: &[f64], shrink: &[f64], available: Option<f64>, clamp_of: &dyn Fn(usize, f64) -> f64) -> Vec<f64> {
    let n = bases.len();
    let mut sizes: Vec<f64> = bases.to_vec();
    let hypothetical: Vec<f64> = (0..n).map(|i| clamp_of(i, bases[i])).collect();
    let wanted: f64 = hypothetical.iter().sum();
    let room = available.unwrap_or(wanted);
    let growing = room >= wanted;
    let factor_of = |i: usize| if growing { grow[i] } else { shrink[i] * inner[i] };
    let flex_factor_of = |i: usize| if growing { grow[i] } else { shrink[i] };
    let mut frozen = vec![false; n];
    for i in 0..n {
        frozen[i] = flex_factor_of(i) <= 0.0 || if growing { hypothetical[i] < bases[i] } else { hypothetical[i] > bases[i] };
        if frozen[i] {
            sizes[i] = hypothetical[i];
        }
    }
    let mut raw = vec![0.0f64; n];
    let mut initial: Option<f64> = None;
    for _round in 0..=n {
        let (mut free, mut weight, mut factors) = (room, 0.0f64, 0.0f64);
        for i in 0..n {
            if frozen[i] {
                free -= sizes[i];
                continue;
            }
            free -= bases[i];
            weight += factor_of(i);
            factors += flex_factor_of(i);
        }
        if weight <= 0.0 {
            break;
        }
        let init = *initial.get_or_insert(free);
        let mut space = free;
        if factors < 1.0 {
            let part = init * factors;
            if part.abs() < free.abs() {
                space = part;
            }
        }
        let mut violation = 0.0f64;
        for i in 0..n {
            if frozen[i] {
                continue;
            }
            raw[i] = bases[i] + (space * factor_of(i)) / weight;
            sizes[i] = clamp_of(i, raw[i]);
            violation += sizes[i] - raw[i];
        }
        if violation == 0.0 {
            break;
        }
        for i in 0..n {
            if !frozen[i] && (if violation > 0.0 { sizes[i] > raw[i] } else { sizes[i] < raw[i] }) {
                frozen[i] = true;
            }
        }
    }
    sizes
}

// Whether a box's content is ALL out of flow — an element with children, every one absolutely positioned,
// and no text (the oracle's `outOfFlowOnly`): its zero content width is real, not a measurement that failed.
fn out_of_flow_only(i: usize, inputs: &[Cell<Input>], children: &[Vec<usize>]) -> bool {
    let n = inputs[i].get();
    if n.display == DISPLAY_TEXT_BLOCK || children[i].is_empty() {
        return false;
    }
    children[i].iter().all(|&c| inputs[c].get().out_of_flow != 0 && inputs[c].get().nid >= 0.0)
}

// A flex ROW's item widths, resolved natively — the oracle's `flexRowMetrics` + `resolveFlexRowWidths` per
// line. `flow` indexes the in-flow items (positions into `kids`); `lines` groups them. Each item's flex BASE is,
// in the spec's order, its `flex-basis` (a length, or an intrinsic keyword answered from its content), else its
// declared width (unless the basis is `content`), else its content's max-content (`intrinsic_widths`) — and
// whether that base came FROM the content, in which case it is its own minimum and no floor can bind. The
// automatic minimum (`min-width: auto`) is the item's min-content — zero when it scrolls in the main axis —
// applied only where it can bind; a declared min/max-width clamps on top (max first, §4.5). What an item's
// lines have left is shared by `resolve_flexible_lengths`; an item that measured NOTHING (a wrapper around
// blocks, no basis / width / text) takes an equal share of the line instead of collapsing to zero — unless its
// content is all out of flow, where zero is real. Returns the per-position width, or None when an item's
// content isn't natively measurable (the JS gate should have routed the container to the pushed path).
fn flex_row_sizes(
    kids: &[usize],
    flow: &[usize],
    lines: &mut Vec<Vec<usize>>,
    content_w: f64,
    gap: f64,
    wrap: bool,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<Vec<f64>> {
    let cnt = kids.len();
    let mut base = vec![0.0f64; cnt];
    let mut content_based = vec![false; cnt];
    let mut min_auto: Vec<Option<f64>> = vec![None; cnt]; // memoised automatic minimum
    for &p in flow {
        let c = kids[p];
        let k = inputs[c].get();
        let edges = k.edges_x();
        let extra = if k.border_box { 0.0 } else { edges };
        let basis = k.flex_basis_at(content_w);
        base[p] = if !is_auto(basis) {
            basis + extra
        } else if matches!(k.flex_basis_kw, 2 | 3 | 4) {
            content_based[p] = true;
            let (wmin, wmax) = content_intrinsic(c, inputs, runs, run_texts, grids, children)?;
            let inner = match k.flex_basis_kw {
                2 => wmin,
                3 => wmax,
                _ => wmin.max((content_w - Input::m(k.ml) - Input::m(k.mr)).max(0.0)).min(wmax),
            };
            inner + edges
        } else if k.flex_basis_kw != 1 && !is_auto(k.width) {
            k.width + extra
        } else if k.replaced {
            // A replaced item's base is its intrinsic width plus its edges — a ratio-only one takes the room.
            content_based[p] = true;
            if k.ratio_only { (content_w - Input::m(k.ml) - Input::m(k.mr)).max(0.0) } else { k.intrinsic_w + edges }
        } else {
            content_based[p] = true;
            // What the item's CONTENT wants, its BASIS-LESS edges corrected to the real ones: a percentage
            // padding resolves against nothing in an intrinsic measure but against this container's content width
            // in the item's box (the oracle's `flexRowMetrics`). The two arms differ in BOTH of the ways that
            // matters: `flex-basis: content` looks PAST a declared width, which only `content_intrinsic` does
            // (`intrinsic_widths` would pin the base to it) — and it answers a CONTENT width, so the real edges
            // go on whole, where `intrinsic_widths` already carries the basis-less ones. Using `content_intrinsic`
            // for BOTH loses the per-display dispatch a nested flex / grid / table item needs (it would be
            // measured as a stack of blocks) — two css-flexbox WPT tests caught exactly that.
            if k.flex_basis_kw == 1 {
                content_intrinsic(c, inputs, runs, run_texts, grids, children)?.1 + edges
            } else {
                intrinsic_widths(c, inputs, runs, run_texts, grids, children)?.1 + edges - k.decl_edges_x
            }
        };
    }
    // The automatic minimum (`min-width: auto`), measured at most once per item and only where the clamp can
    // ask for it — the oracle measures lazily, at the first round that shrinks an item below its base. A
    // content-based item's base is its own maximum, so its floor is asked only once its line SHRINKS; every
    // other auto-minimum item's floor is asked by its hypothetical size.
    let floor_of = |p: usize, inputs: &[Cell<Input>]| -> Option<f64> {
        let c = kids[p];
        let k = inputs[c].get();
        Some(if k.scrolls_x { k.edges_x() } else { min_content_width(c, inputs, runs, run_texts, grids, children)? })
    };
    for &p in flow {
        if is_auto(inputs[kids[p]].get().min_w) && !content_based[p] {
            min_auto[p] = Some(floor_of(p, inputs)?);
        }
    }
    let clamp_with = |floors: &Vec<Option<f64>>, p: usize, size: f64| -> f64 {
        let k = inputs[kids[p]].get();
        let extra = if k.border_box { 0.0 } else { k.edges_x() };
        let mut out = size;
        if is_auto(k.min_w) && !(content_based[p] && size >= base[p]) {
            out = out.max(floors[p].unwrap_or(0.0));
        }
        if !is_auto(k.max_w) && k.max_w >= 0.0 {
            out = out.min(k.max_w + extra);
        }
        if !is_auto(k.min_w) && k.min_w >= 0.0 {
            out = out.max(k.min_w + extra);
        }
        out
    };
    // Lines are broken on the HYPOTHETICAL outer sizes (each base clamped) — `flexLines`. A content-based
    // item's hypothetical size is at least its base, so no unmeasured floor is consulted here.
    let clamp_of = |p: usize, size: f64| clamp_with(&min_auto, p, size);
    if wrap && flow.len() > 1 {
        let mut ls: Vec<Vec<usize>> = Vec::new();
        let mut cur: Vec<usize> = Vec::new();
        let mut used = 0.0;
        for &p in flow {
            let k = inputs[kids[p]].get();
            let outer = clamp_of(p, base[p]) + Input::m(k.ml) + Input::m(k.mr);
            if !cur.is_empty() && used + gap + outer > content_w {
                ls.push(std::mem::take(&mut cur));
                used = 0.0;
            }
            used += if cur.is_empty() { 0.0 } else { gap } + outer;
            cur.push(p);
        }
        ls.push(cur);
        *lines = ls;
    } else {
        *lines = vec![flow.to_vec()];
    }
    let mut widths = vec![0.0f64; cnt];
    for line in lines.iter() {
        let n = line.len();
        let mut taken = gap * n.saturating_sub(1) as f64;
        for &p in line {
            let k = inputs[kids[p]].get();
            taken += Input::m(k.ml) + Input::m(k.mr);
        }
        let avail = (content_w - taken).max(0.0);
        let share = if n > 0 { (avail / n as f64).floor() } else { avail };
        let bases: Vec<f64> = line.iter().map(|&p| base[p]).collect();
        // A line that SHRINKS (its hypothetical sizes exceed the room) may take a content-based item below its
        // base, where its floor binds — measure those floors now, before the resolution asks for them.
        let wanted: f64 = line.iter().map(|&p| clamp_of(p, base[p])).sum();
        let mut floors = min_auto.clone();
        if wanted > avail {
            for &p in line {
                if is_auto(inputs[kids[p]].get().min_w) && floors[p].is_none() {
                    floors[p] = Some(floor_of(p, inputs)?);
                }
            }
        }
        let inner: Vec<f64> = line.iter().map(|&p| {
            let k = inputs[kids[p]].get();
            (base[p] - if k.border_box { 0.0 } else { k.edges_x() }).max(0.0)
        }).collect();
        let grow: Vec<f64> = line.iter().map(|&p| inputs[kids[p]].get().flex_grow).collect();
        let shrink: Vec<f64> = line.iter().map(|&p| inputs[kids[p]].get().flex_shrink).collect();
        let line_clamp = |j: usize, size: f64| clamp_with(&floors, line[j], size);
        let sizes = resolve_flexible_lengths(&bases, &inner, &grow, &shrink, Some(avail), &line_clamp);
        for (j, &p) in line.iter().enumerate() {
            let w = sizes[j];
            widths[p] = if w > 0.0 || !content_based[p] || out_of_flow_only(kids[p], inputs, children) { w } else { share };
        }
    }
    Some(widths)
}

// A flex COLUMN's item sizes, resolved natively — the oracle's `layoutFlexColumn` up to placement. The CROSS axis
// first: an item's width is its declared width, else the container's room when it stretches (a single-line
// column's line IS the container) or its shrink-to-fit width (`intrinsic_widths` clamped to the room), clamped by
// its min/max-width. Its flex BASE is its `flex-basis` (a length against the main size, content-box per
// `box-sizing`), else its declared height, else its content height MEASURED at that width; the automatic minimum
// (`min-height: auto`) is that same measure (zero when the item scrolls), asked only where it can bind, and the
// declared min/max-height clamp on top. A WRAPPING column breaks against a DEFINITE main size (the height, or a
// `max-height` cap), each line as wide as its widest item, `align-content` growing the lines, and a stretched item
// is then widened to its line (`restretched`). Each line's heights are shared by `resolve_flexible_lengths`
// against the definite main size, or re-resolved against a `min-height` floor the items underrun or a
// `max-height` cap they overrun. Returns per position (width, height, imposed): `imposed` says the height is
// handed to the item as definite (the oracle's `imposed` — a definite column, a restretched item, or a height
// the measure did not already produce); else the item keeps its auto height. `main` is the definite main size
// or the min-height floor (NaN = none); `capacity` the size lines break against (NaN = single line).
fn flex_column_sizes(
    kids: &[usize],
    flow: &[usize],
    lines: &mut Vec<Vec<usize>>,
    line_crosses: &mut Vec<f64>,
    content_w: f64,
    main: f64,
    height_definite: bool,
    capacity: f64,
    cap: f64,
    gap: f64,
    cross_gap: f64,
    wrap: bool,
    align_content_code: u8,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> Option<Vec<(f64, f64, bool)>> {
    let cnt = kids.len();
    let floor = if height_definite { f64::NAN } else { main };
    // A MULTI-LINE container is one that SAYS `wrap` (its items shrink to fit and its line is as wide as its
    // widest item, `align-content` placing it); it BREAKS only against a definite capacity with more than one item.
    let multiline = wrap;
    let breaks = multiline && !is_auto(capacity) && flow.len() > 1;
    let mut width = vec![0.0f64; cnt];
    let mut decl_h = vec![f64::NAN; cnt]; // the declared border-box height, NaN = auto
    for &p in flow {
        let c = kids[p];
        let k = inputs[c].get();
        let avail_w = (content_w - Input::m(k.ml) - Input::m(k.mr)).max(0.0);
        // A stretched item fills its line — the container, single-line; a multi-line column's line is only as wide
        // as its widest item, so the item starts at its shrink-to-fit width and is re-stretched once the line has
        // a size — except a RATIO box, whose two axes are derived from each other: it takes the container's width
        // in both paths (the oracle's `ratioBox`).
        let auto_w = if k.flex_stretch && (!multiline || (k.replaced && k.ratio)) {
            avail_w
        } else {
            shrink_to_fit_width(c, avail_w, inputs, runs, run_texts, grids, children)?
        };
        width[p] = used_width(&k, auto_w);
        // STRETCH beats an intrinsic size: a replaced item with a size but no ratio (a control, an iframe) is the
        // line's cross size; a ratio box keeps its own (the oracle re-derives nothing through the ratio).
        if k.replaced && !k.ratio && k.flex_stretch && !multiline {
            let extra = if k.border_box { 0.0 } else { k.edges_x() };
            let to_border = |v: f64| if is_auto(v) { v } else { v + extra };
            width[p] = clamp_min_max(avail_w, to_border(k.min_w), to_border(k.max_w));
        }
        if k.replaced {
            decl_h[p] = replaced_box(&k, auto_w).1; // a replaced item's height is definite (its size, at that width)
        } else if !is_auto(k.height) {
            let edges_y = k.edges_y();
            let h = if k.border_box { k.height.max(edges_y) } else { k.height + edges_y };
            let to_border = |v: f64| if is_auto(v) || k.border_box { v } else { v + edges_y };
            decl_h[p] = clamp_min_max(h, to_border(k.min_h), to_border(k.max_h)).max(0.0);
        }
    }
    // The content height of item `p` at its current width, measured at most once (its auto height, the
    // declared one set aside — MEASURE_AUTO_HEIGHT), memoised in `measured`.
    let mut measured: Vec<Option<f64>> = vec![None; cnt];
    let measure_of = |p: usize, width: &Vec<f64>, measured: &mut Vec<Option<f64>>, boxes: &mut [Box]| -> f64 {
        if measured[p].is_none() {
            let c = kids[p];
            measure(c, width[p], MEASURE_AUTO_HEIGHT, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            measured[p] = Some(boxes[c].h);
        }
        measured[p].unwrap()
    };
    let mut base = vec![0.0f64; cnt];
    let mut base_measured = vec![false; cnt];
    for &p in flow {
        let k = inputs[kids[p]].get();
        let extra = if k.border_box { 0.0 } else { k.edges_y() };
        let basis = k.flex_basis_at(main);
        base[p] = if k.flex_basis_kw == 0 && !is_auto(basis) {
            basis + extra
        } else if !is_auto(decl_h[p]) && k.flex_basis_kw == 0 {
            decl_h[p]
        } else {
            base_measured[p] = true;
            measure_of(p, &width, &mut measured, boxes)
        };
    }
    // The automatic minimum: the item's content height (zero when it scrolls down), memoised in `auto_min`.
    let mut auto_min: Vec<Option<f64>> = vec![None; cnt];
    let auto_min_of = |p: usize, width: &Vec<f64>, measured: &mut Vec<Option<f64>>, auto_min: &mut Vec<Option<f64>>, boxes: &mut [Box]| -> f64 {
        if auto_min[p].is_none() {
            let k = inputs[kids[p]].get();
            auto_min[p] = Some(if k.scrolls_y {
                0.0
            } else {
                let m = measure_of(p, width, measured, boxes);
                if is_auto(decl_h[p]) { m } else { decl_h[p].min(m) }
            });
        }
        auto_min[p].unwrap()
    };
    // The floor is asked wherever the clamp can bind AT THE BASE already — the oracle's `clampOf` measures it
    // when `known == null || size < known`, `known` being the measure (an item whose base was measured already
    // holds it) or the declared height: an auto-height item with a basis has no other minimum, and a basis
    // BELOW a declared height binds on any line. Only a declared-height item at or above its declaration is
    // measured lazily, where a line SHRINKS it (the oracle's lazy `automaticMinHeight`), so a column of
    // fixed-height rows costs one layout per item.
    for &p in flow {
        if is_auto(inputs[kids[p]].get().min_h) {
            let known = if base_measured[p] { measured[p] } else if is_auto(decl_h[p]) { None } else { Some(decl_h[p]) };
            if known.map_or(true, |kn| base[p] < kn) {
                auto_min_of(p, &width, &mut measured, &mut auto_min, boxes);
            }
        }
    }
    let clamp_with = |floors: &Vec<Option<f64>>, measured: &Vec<Option<f64>>, p: usize, size: f64| -> f64 {
        let k = inputs[kids[p]].get();
        let mut out = size;
        if is_auto(k.min_h) {
            let known = if base_measured[p] { measured[p] } else if is_auto(decl_h[p]) { None } else { Some(decl_h[p]) };
            if known.map_or(true, |kn| size < kn) {
                out = out.max(floors[p].unwrap_or(0.0));
            }
        }
        let extra = if k.border_box { 0.0 } else { k.edges_y() };
        if !is_auto(k.max_h) && k.max_h >= 0.0 {
            out = out.min(k.max_h + extra);
        }
        if !is_auto(k.min_h) && k.min_h >= 0.0 {
            out = out.max(k.min_h + extra);
        }
        out
    };
    // A base-measured item's hypothetical size is at least its base, a declared one's is its declaration:
    // no unmeasured floor is consulted by the line breaker.
    // §9.3 down the block axis: lines broken on the hypothetical outer heights against the capacity.
    if breaks {
        let clamp_of = |p: usize, size: f64| clamp_with(&auto_min, &measured, p, size);
        let mut ls: Vec<Vec<usize>> = Vec::new();
        let mut cur: Vec<usize> = Vec::new();
        let mut used = 0.0;
        for &p in flow {
            let k = inputs[kids[p]].get();
            let outer = clamp_of(p, base[p]) + Input::m(k.mt) + Input::m(k.mb);
            if !cur.is_empty() && used + gap + outer > capacity {
                ls.push(std::mem::take(&mut cur));
                used = 0.0;
            }
            used += if cur.is_empty() { 0.0 } else { gap } + outer;
            cur.push(p);
        }
        ls.push(cur);
        *lines = ls;
    } else {
        *lines = vec![flow.to_vec()];
    }
    // §9.6 across it: each line as wide as its widest item (its NATURAL cross, handed back in `line_crosses` for
    // the placement to stack by `align-content`), the lines grown by `align-content`; a stretched item is then
    // widened to its grown line, clamped by its min/max-width (`restretched`).
    let mut restretched = vec![false; cnt];
    if multiline {
        let nl = lines.len();
        let crosses: Vec<f64> = lines.iter().map(|line| line.iter().map(|&p| {
            let k = inputs[kids[p]].get();
            width[p] + Input::m(k.ml) + Input::m(k.mr)
        }).fold(0.0, f64::max)).collect();
        let stacked: f64 = crosses.iter().sum::<f64>() + cross_gap * nl.saturating_sub(1) as f64;
        // …only the GROW, which is how much each line gains and so is the same whichever way they stack.
        let (_, _, grow) = align_content(align_content_code, content_w - stacked, nl, false, false);
        *line_crosses = crosses.clone();
        for (li, line) in lines.iter().enumerate() {
            let line_cross = crosses[li] + grow;
            for &p in line {
                let k = inputs[kids[p]].get();
                if k.flex_stretch {
                    let room = (line_cross - Input::m(k.ml) - Input::m(k.mr)).max(0.0);
                    let extra = if k.border_box { 0.0 } else { k.edges_x() };
                    let to_border = |v: f64| if is_auto(v) { v } else { v + extra };
                    let w = clamp_min_max(room, to_border(k.min_w), to_border(k.max_w));
                    if w != width[p] {
                        width[p] = w;
                        restretched[p] = true;
                    }
                }
            }
        }
    }
    // The main sizes, per line.
    let mut out = vec![(0.0f64, 0.0f64, false); cnt];
    for line in lines.iter() {
        let k_n = line.len();
        let mut taken = gap * k_n.saturating_sub(1) as f64;
        for &p in line {
            let k = inputs[kids[p]].get();
            taken += Input::m(k.mt) + Input::m(k.mb);
        }
        let bases: Vec<f64> = line.iter().map(|&p| base[p]).collect();
        let inner: Vec<f64> = line.iter().map(|&p| {
            let k = inputs[kids[p]].get();
            (base[p] - if k.border_box { 0.0 } else { k.edges_y() }).max(0.0)
        }).collect();
        let grow_f: Vec<f64> = line.iter().map(|&p| inputs[kids[p]].get().flex_grow).collect();
        let shrink_f: Vec<f64> = line.iter().map(|&p| inputs[kids[p]].get().flex_shrink).collect();
        let available = if height_definite { Some((main - taken).max(0.0)) } else { None };
        // A line that SHRINKS (its hypothetical sizes exceed the room — the definite height, or the cap the
        // items overrun) may take an item below its declaration, where its floor binds: measure those now.
        let wanted: f64 = line.iter().map(|&p| clamp_with(&auto_min, &measured, p, base[p])).sum();
        let shrinks = available.map_or(false, |a| wanted > a) || (!height_definite && !is_auto(cap) && taken + wanted > cap);
        let mut floors = auto_min.clone();
        if shrinks {
            for &p in line {
                if is_auto(inputs[kids[p]].get().min_h) && floors[p].is_none() {
                    floors[p] = Some(auto_min_of(p, &width, &mut measured, &mut auto_min, boxes));
                }
            }
        }
        let line_clamp = |j: usize, size: f64| clamp_with(&floors, &measured, line[j], size);
        let mut heights = resolve_flexible_lengths(&bases, &inner, &grow_f, &shrink_f, available, &line_clamp);
        let mut used = taken + heights.iter().sum::<f64>();
        if !is_auto(floor) && used < floor {
            heights = resolve_flexible_lengths(&bases, &inner, &grow_f, &shrink_f, Some((floor - taken).max(0.0)), &line_clamp);
            used = taken + heights.iter().sum::<f64>();
        }
        if !height_definite && !is_auto(cap) && used > cap {
            heights = resolve_flexible_lengths(&bases, &inner, &grow_f, &shrink_f, Some((cap - taken).max(0.0)), &line_clamp);
        }
        for (j, &p) in line.iter().enumerate() {
            let h = heights[j];
            let imposed = height_definite || restretched[p] || measured[p].map_or(true, |m| m != h) || !is_auto(decl_h[p]);
            out[p] = (width[p], h, imposed);
        }
    }
    Some(out)
}

fn measure_flex(
    i: usize,
    w: f64,
    imposed_h: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> MInfo {
    let n = inputs[i].get().with_imposed_height(imposed_h);
    let content_w = n.content_w(w);
    let content_left_rel = n.bl + n.pl;
    let content_top_rel = n.bt + n.pt;
    let edges_y = n.edges_y();
    let main_is_x = n.flex_main_is_x; // row: main = X/width; column: main = Y/height
    // The gaps' percentage parts resolve here: the MAIN gap against a row's content width or a column's main size
    // (nothing where that is indefinite), the CROSS gap against a row's definite content height or a column's width.
    let main_basis = if main_is_x { content_w } else { n.column_main() };
    let gap = n.flex_main_gap + if n.flex_main_gap_frac != 0.0 && !is_auto(main_basis) { n.flex_main_gap_frac * main_basis } else { 0.0 };
    let cross_basis = if main_is_x { n.definite_content_h().unwrap_or(0.0) } else { content_w };
    let cross_gap = n.flex_cross_gap + n.flex_cross_gap_frac * cross_basis;
    let cnt = children[i].len();

    let kids: Vec<usize> = children[i].clone();
    // In-flow item positions (into `kids`). OUT-OF-FLOW children (abspos/fixed, §4.1) are removed from flex
    // sizing and line breaking — their subtrees are laid out at their pushed box, and they are placed separately.
    let flow: Vec<usize> = (0..cnt).filter(|&p| inputs[kids[p]].get().out_of_flow == 0).collect();
    // A ROW sized NATIVELY (`flex_native`): each in-flow item's width is resolved here (`flex_row_sizes` —
    // base, clamps, line breaking, grow/shrink), and its subtree laid out at that width; the pushed path lays
    // each item out at its oracle-resolved box. Either way record order == flex order (the harness sorted by
    // `order`), each item in a fresh float context.
    let native_row = n.flex_native && main_is_x;
    let native_col = n.flex_native && !main_is_x;
    let mut native_lines: Vec<Vec<usize>> = Vec::new();
    let mut native_line_crosses: Vec<f64> = Vec::new(); // a native multi-line column's NATURAL line crosses
    if native_col {
        // The column's main size: its definite content height, else a min-height FLOOR (NaN = none); lines break
        // against the definite height or a max-height CAP (NaN = one line).
        let to_border_y = |v: f64| if is_auto(v) || n.border_box { v } else { v + edges_y };
        // Definite as the oracle reads it: a declared or imposed height — not a PUSHED auto-height column
        // (`item_auto_height`), whose record carries its final box but whose main size is still its content.
        let height_definite = n.definite_content_h().is_some();
        let cap_main = if is_auto(n.max_h) || n.max_h < 0.0 { f64::NAN } else { (to_border_y(n.max_h) - edges_y).max(0.0) };
        let main = n.column_main();
        let capacity = if height_definite { main } else { cap_main };
        let sizes = match flex_column_sizes(&kids, &flow, &mut native_lines, &mut native_line_crosses, content_w, main, height_definite, capacity, cap_main, gap, cross_gap, n.flex_wrap, n.flex_align_content, inputs, runs, run_texts, grids, children, boxes, failed) {
            Some(sz) => sz,
            None => {
                failed.set(true);
                return MInfo { top: CMargin::of(0.0), top_only: CMargin::of(0.0), bottom: CMargin::of(0.0), collapse_through: false };
            }
        };
        for &p in &flow {
            let (w_p, h_p, imposed) = sizes[p];
            // An item whose measure already produced its height keeps that layout (the oracle reuses it); the
            // rest are laid out at their resolved height, definite.
            if imposed || boxes[kids[p]].w != w_p {
                measure(kids[p], w_p, if imposed { h_p } else { f64::NAN }, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            }
        }
        for &c in &kids {
            if inputs[c].get().out_of_flow != 0 && !inputs[c].get().native_oof() {
                let iw = resolve_width(&inputs[c].get(), content_w);
                measure(c, iw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            }
        }
    } else if native_row {
        let widths = match flex_row_sizes(&kids, &flow, &mut native_lines, content_w, gap, n.flex_wrap, inputs, runs, run_texts, grids, children) {
            Some(ws) => ws,
            None => {
                failed.set(true);
                return MInfo { top: CMargin::of(0.0), top_only: CMargin::of(0.0), bottom: CMargin::of(0.0), collapse_through: false };
            }
        };
        for &p in &flow {
            measure(kids[p], widths[p], f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        }
        for &c in &kids {
            if inputs[c].get().out_of_flow != 0 && !inputs[c].get().native_oof() {
                let iw = resolve_width(&inputs[c].get(), content_w);
                measure(c, iw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            }
        }
    } else {
        for &c in &kids {
            if inputs[c].get().native_oof() {
                continue; // sized and placed by place_out_of_flow
            }
            let iw = resolve_width(&inputs[c].get(), content_w);
            measure(c, iw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        }
    }

    // Per-item OUTER extents (size + the two margins) along the main and cross axes, plus the leading
    // main/cross margin, parallel to `children[i]` (so the line logic never re-borrows `boxes`). The item
    // cross sizes are the FINAL (pushed, post-stretch) ones, so a line's cross already includes whatever
    // align-content:stretch grew it to — native positions the lines, it never re-grows them.
    let main_reverse = n.flex_main_reverse;
    let (mut mo, mut co, mut ml_lead, mut cl_lead) = (Vec::with_capacity(cnt), Vec::with_capacity(cnt), Vec::with_capacity(cnt), Vec::with_capacity(cnt));
    for &c in &kids {
        let cn = inputs[c].get();
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
    let lines: Vec<Vec<usize>> = if native_row || native_col {
        native_lines // broken on the hypothetical sizes by flex_row_sizes / flex_column_sizes
    } else if n.flex_wrap && wrap_capacity {
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
    let mut line_first_extent = vec![0.0f64; nlines];
    let mut line_last_asc = vec![0.0f64; nlines];
    let mut line_last_extent = vec![0.0f64; nlines];
    // Each item's baseline ASCENT within its margin box — the oracle's `baselineParts.asc`: its own first (or, for
    // a `last baseline` item, last) baseline plus its top margin, clamped into the box when the item scrolls
    // down (a scroll container's baseline comes from its border box), else its bottom margin edge when it has no
    // line to give. Read from the natively laid-out item where this container sizes its items itself; a pushed
    // item carries the oracle's figure (rec[42]).
    // …asked only where a member actually hangs from a baseline, which almost no page does: the scan below
    // reads two `Box` fields per item and allocates a vector per container, on a path every flex container
    // takes (rule 3, the `mayConstrainSize` pattern). One pass over the aligns answers it.
    let any_baseline = kids
        .iter()
        .any(|&c| matches!(inputs[c].get().flex_cross_align, CROSS_BASELINE | CROSS_BASELINE_LAST));
    let bl_asc: Vec<f64> = if !any_baseline { Vec::new() } else { (0..cnt).map(|p| {
        let c = kids[p];
        let k = inputs[c].get();
        if !n.flex_native {
            return k.flex_baseline_asc;
        }
        let own = if k.flex_cross_align == CROSS_BASELINE_LAST { boxes[c].last_baseline } else { boxes[c].first_baseline };
        match own {
            Some(o) => (if k.scrolls_y { o.max(0.0).min(boxes[c].h) } else { o }) + Input::m(k.mt),
            None => boxes[c].h + Input::m(k.mt) + Input::m(k.mb),
        }
    }).collect() };
    // …so the table is EMPTY when no item hangs from a baseline, and the readers say so themselves rather than
    // leaning on that (an index would panic if the two ever disagreed): every arm that uses an ascent is an
    // arm a baseline align reached, where the table is filled.
    let asc_of = |p: usize| bl_asc.get(p).copied().unwrap_or(0.0);
    for (li, line) in lines.iter().enumerate() {
        let (mut plain, mut fa, mut fb, mut la, mut lb) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for &p in line {
            let asc = asc_of(p);
            match inputs[kids[p]].get().flex_cross_align {
                CROSS_BASELINE => { fa = fa.max(asc); fb = fb.max(co[p] - asc); }
                CROSS_BASELINE_LAST => { la = la.max(asc); lb = lb.max(co[p] - asc); }
                _ => plain = plain.max(co[p]),
            }
        }
        // A natively-sized multi-line COLUMN's line cross is its NATURAL one (the widest item before any stretch
        // widened it to the grown line) — `align-content` below grows it, as the oracle's stackFlexLines does; the
        // final item widths already fill the grown line, so measuring from them would grow it twice.
        line_cross[li] = if native_col && li < native_line_crosses.len() { native_line_crosses[li] } else { plain.max(fa + fb).max(la + lb) };
        line_first_asc[li] = fa;
        line_first_extent[li] = fa + fb;
        line_last_asc[li] = la;
        line_last_extent[li] = la + lb;
    }

    // The container's CROSS content extent + its own box. The cross is a row's height (auto = the stacked
    // lines, else the declared content height) and a column's content width (always definite here).
    let lines_cross_sum: f64 = line_cross.iter().sum::<f64>() + cross_gap * nlines.saturating_sub(1) as f64;
    let (box_w, box_h, container_cross, definite_cross) = if main_is_x {
        // A ROW's cross is its HEIGHT, clamped by min/max-height — but the clamp is TWO-PHASE and hinges on
        // whether the height is declared (the oracle: `definiteCross = box.height !== 0 || autoHeight ===
        // false`, clamp applied in layoutElement). A DECLARED height is clamped BEFORE layout, so the items
        // align in the clamped cross (definite). An AUTO height is NOT: the items align in the CONTENT cross
        // (the stacked lines), and min/max-height then grows/shrinks the FINAL box around them WITHOUT moving
        // them — so container_cross stays the unclamped content (a min-height:100 app-shell row of a 30px
        // item keeps the item at the top and grows the box to 100; align-content sees free = 0). A pushed flex
        // ITEM whose OWN height is auto reaches here with `height` overwritten by its final (clamped) box, but
        // `item_auto_height` (rec[54]) carries its autoHeight so it takes this SAME auto path — recomputing the
        // box from its content and two-phasing the clamp (a min-height FLOOR aligns its items in the pre-floor
        // content, a max-height CAP its taller content overflows — the Avo `field-wrapper` row). A genuinely
        // DEFINITE height (declared, or stretch/abspos-imposed — autoHeight false) takes the else branch below.
        if is_auto(n.height) || n.item_auto_height {
            // A bare-text anonymous item floors the row's auto cross at its line-height. Unlike a min-height
            // (clamped later, outside the flex pass), the oracle folds it into box.height HERE and reads
            // container_cross back from the grown box (layout.js: `containerCross = box.height - edges`), so the
            // single nowrap line grows to it and its items align WITHIN that floor — and a wrapping row shares
            // the surplus (anon − stacked) out through align-content. So container_cross carries the floor too,
            // not just box_h. (Pre-clamp, like the oracle: box.height is grown before the outer min/max clamp.)
            let bh = clamp_min_max(lines_cross_sum.max(n.anon_cross) + edges_y, to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0);
            (w, bh, lines_cross_sum.max(n.anon_cross), false)
        } else {
            // A declared height is never smaller than the box's own border+padding (usedSize's border-box floor).
            let bh = clamp_min_max(to_border_y(n.height), to_border_y(n.min_h), to_border_y(n.max_h)).max(edges_y).max(0.0);
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
            clamp_min_max(to_border_y(n.height), to_border_y(n.min_h), to_border_y(n.max_h)).max(edges_y).max(0.0)
        };
        (w, bh, content_w, true) // a column's cross (width) is always definite
    };

    // Per-line cross SIZE and cross-START. A NOWRAP line takes the whole container cross (§9.6 — a definite
    // cross fills it, an auto one is the line's own); a WRAP container stacks its lines by align-content
    // (the stretch GROW is already in the item sizes, so only the lead/between positioning is applied).
    let cross_start_base = if main_is_x { content_top_rel } else { content_left_rel };
    // Does the cross axis run back from the far physical edge? An rtl COLUMN, a `*-rl` mode's ROW, and
    // anything under `wrap-reverse`. The item keywords arrive resolved onto the physical cross already, and
    // each line still runs cross-start to cross-end inside itself; what reverses here is the STACK.
    let cross_far = n.flex_cross_far;
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
        let free = container_cross - lines_cross_sum;
        // `align_content` answers a lead already measured from the container's NEAR PHYSICAL edge, reversal
        // and all — the stretch case is not the same mirror as the others, so it is made there and not here.
        let (ac_lead, ac_between, ac_grow) = align_content(n.flex_align_content, free, nlines, cross_far, n.flex_cross_flip);
        // …and the lines themselves stack from the far edge: a `wrap-reverse` row's FIRST line is lowest, an
        // rtl column's rightmost, while `ac_grow` still hands each of them the same share. Walked by index
        // rather than through a reversed vector — this runs per wrapping flex container per pass (rule 3).
        let placed = |k: usize| if cross_far { nlines - 1 - k } else { k };
        let mut cross_at = cross_start_base + ac_lead;
        for k in 0..nlines {
            let li = placed(k);
            line_lc[li] = line_cross[li] + ac_grow;
            line_cs[li] = cross_at;
            cross_at += line_lc[li] + cross_gap + ac_between;
        }
        // Lines that STRETCH fill the cross size exactly, so the last one PLACED is closed against the
        // container's far edge rather than left where an equal share of the free space accumulated to
        // (stackFlexLines).
        if ac_grow > 0.0 && nlines > 0 {
            let last = placed(nlines - 1);
            line_lc[last] = (cross_start_base + container_cross - line_cs[last]).max(0.0);
        }
    }

    // A natively-sized row STRETCHES its stretching items to their line now that the lines have a cross size
    // (§9.4 step 11): the item is laid out again at the line's cross less its margins as an IMPOSED height
    // (its min/max-height still clamp), so its own contents see the taller box. The line's cross was measured
    // from the items' natural (hypothetical) heights, as the oracle's measureLineCross does before stackFlexLines.
    if native_row {
        for (li, line) in lines.iter().enumerate() {
            for &p in line {
                let c = kids[p];
                let cn = inputs[c].get();
                if !cn.flex_stretch {
                    continue;
                }
                let room = line_lc[li] - Input::m(cn.mt) - Input::m(cn.mb);
                if boxes[c].h != room {
                    measure(c, boxes[c].w, room, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                    co[p] = boxes[c].h + Input::m(cn.mt) + Input::m(cn.mb);
                }
            }
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
        let line_autos: usize = line.iter().map(|&p| (inputs[kids[p]].get().flex_item_auto & 1) as usize + ((inputs[kids[p]].get().flex_item_auto >> 1) & 1) as usize).sum();
        let each_auto = if line_autos > 0 && free > 0.0 { free / line_autos as f64 } else { 0.0 };
        let (m_lead, m_between) = if line_autos > 0 && free > 0.0 { (0.0, 0.0) } else { flex_distribution(n.flex_justify, free, line.len()) };
        let mut at = m_lead;
        for (k, &p) in line.iter().enumerate() {
            let c = kids[p];
            let auto = inputs[c].get().flex_item_auto;
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
                let off = match inputs[c].get().flex_cross_align {
                    1 => (lc - co[p]) / 2.0, // center
                    2 => lc - co[p],         // end
                    // baseline: hang from the line's shared baseline (the group's deepest ascent), so every
                    // member's own baseline coincides at line_first_asc. The FIRST-baseline group anchors at
                    // the cross-START and the LAST-baseline one at the cross-END — which physical edge each of
                    // those is is what a REVERSED cross swaps (the oracle's `baselineOffset`: `atStart =
                    // first !== crossFlip`).
                    // (Only a ROW ever arrives here with the keyword: a real COLUMN has `plan.baselineMode`
                    // `axis`, so `crossAlignPhysical` resolved it away, and a VERTICAL writing mode's row —
                    // which lays out along Y and has no baseline geometry to offer — is sent as `flex-start`
                    // by the walk, for the same reason the oracle's column routine ignores the keyword there.)
                    CROSS_BASELINE => {
                        let group_top = if cross_far { lc - line_first_extent[li] } else { 0.0 };
                        group_top + line_first_asc[li] - asc_of(p)
                    }
                    CROSS_BASELINE_LAST => {
                        let group_top = if cross_far { 0.0 } else { lc - line_last_extent[li] };
                        group_top + line_last_asc[li] - asc_of(p)
                    }
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
        if inputs[c].get().out_of_flow != 0 {
            boxes[c].x = 0.0;
            boxes[c].y = 0.0;
        }
    }

    // The container's baselines: from its items in FLEX order — record order, reversed for a `*-reverse`
    // direction (`baselineCandidates`; an rtl row is not reversed there).
    let order: Vec<usize> = if n.flex_dir_reverse { flow.iter().rev().map(|&p| kids[p]).collect() } else { flow.iter().map(|&p| kids[p]).collect() };
    let (fb, lb, ib) = child_baselines(order.into_iter(), inputs, boxes);
    boxes[i].first_baseline = fb;
    boxes[i].last_baseline = lb;
    boxes[i].inline_block_baseline = ib;

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
// caller), so the grow is never double-applied.
//
// `cross_far` says the cross axis runs back from the far physical edge, which the returned LEAD is already
// measured against. The oracle's `alignContentLines`, transcribed in ITS OWN ORDER, because each of its
// three steps sees a different keyword.
fn align_content(code: u8, free: f64, count: usize, cross_far: bool, cross_flip: bool) -> (f64, f64, f64) {
    if code == 6 {
        // Growing lines fill the container, so where the stack STARTS matters only when they OVERFLOW it —
        // and a reversed axis then starts past the container's near edge rather than at it.
        let lead = if cross_far { free.min(0.0) } else { 0.0 };
        return (lead, 0.0, if free > 0.0 && count > 0 { free / count as f64 } else { 0.0 }); // stretch
    }
    let mut c = code;
    // A DISTRIBUTION with no free space falls back to its own alignment, and the two fall back DIFFERENTLY:
    // `space-between` to `flex-start`, which follows the axis, and `space-around` / `space-evenly` to safe
    // `center`, which under overflow is flow `start` and does not. Measured in a 40px `wrap-reverse` row of
    // three 20px lines: 20/0/-20 against 40/20/0.
    if free < 0.0 {
        if c == 3 {
            c = 0;
        } else if c == 4 || c == 5 {
            c = 7;
        }
    }
    // …then the flow-relative pair is resolved onto the axis. It swaps for the WRAP REVERSAL and not for
    // the axis's physical direction: `start` / `end` are writing-mode relative, so a vertical mode carries
    // them round with everything else, and only `wrap-reverse` moves them against their `flex-*` twins.
    c = match (c, cross_flip) {
        (7, true) | (8, false) => 2,
        (8, true) | (7, false) => 0,
        _ => c,
    };
    let (lead, between) = flex_distribution(c, free, count);
    // …and the axis-relative offset turned into a distance from the near physical edge: a reversed axis is
    // the mirror image of itself, so what the lines leave BEYOND the stack in axis terms sits before it.
    let lead = if cross_far { free - lead - between * (count as f64 - 1.0) } else { lead };
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

// ── Tables (§17 / CSS Tables 3) ───────────────────────────────────────────────────────────────────────
// A table in normal flow — `table > (row-group | row)* > cell*`, plus a caption. Native COMPUTES the COLUMN
// tracks (`table_columns` from every cell's own min/max-content, `distribute_columns` / `fixed_column_widths`
// sharing out the width) and the table's own width (declared, or shrink-to-fit its columns), lays each cell out
// at its column width, then sizes every ROW from the cells' own content — a declared cell height a floor, a
// spanning cell topping up the last row it touches, a declared row height a minimum, and a declared TABLE
// height's surplus shared over the body group's auto rows — and prefix-sums both tracks with border-spacing to
// position every cell and DERIVE every row, row-group and the table's OWN box. All boxes are written in their
// immediate parent's
// border-box frame; `place` composes the origins table → group → row → cell → content. Mirrors layoutTable /
// tableColumns / distributeColumns / fixedColumnWidths / tableIntrinsicWidths / tableGrid. Spans, captions,
// colgroup, thead/tfoot reorder, fixed layout, rtl AND border-collapse are all IN scope (the oracle folds the
// collapsed borders into the pushed edges, so a collapse table sizes here exactly like a separate one).
// nlTableSupported declines only what native can't reproduce: rtl combined with a caption or a collapsed
// border, an imposed height the oracle didn't distribute into the rows, an empty or interleaved row group, a
// nested table, and a row whose cells all span rows (no row height to read).
// A table's ROW / COLUMN structure, recovered from the record tree the walk emitted (the oracle's `tableGrid`
// resolved the anonymous boxes and the render order): every row in render order with the row GROUP it belongs
// to, the caption (the table's only non-row / non-group child), and the column count: `declared_cols` (the
// oracle's, which a `<col>` / `<colgroup span>` raises past the cells' own reach) or the last column any cell
// reaches, whichever is larger. `None` for a table native can't read (no rows, no columns, a malformed span).
struct TableGrid {
    rows: Vec<usize>,
    row_group: Vec<Option<usize>>,
    caption: Option<usize>,
    c_count: usize,
}
fn table_grid(i: usize, inputs: &[Cell<Input>], children: &[Vec<usize>], declared_cols: usize) -> Option<TableGrid> {
    let mut rows: Vec<usize> = Vec::new();
    let mut row_group: Vec<Option<usize>> = Vec::new();
    let mut caption = None;
    for &ch in &children[i] {
        match inputs[ch].get().display {
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
            _ => caption = Some(ch),
        }
    }
    if rows.is_empty() {
        return None;
    }
    let mut c_count = declared_cols;
    for &r in &rows {
        for &c in &children[r] {
            let k = inputs[c].get();
            if k.cell_colspan == 0 || k.cell_rowspan == 0 {
                return None;
            }
            c_count = c_count.max(k.cell_col + k.cell_colspan);
        }
    }
    if c_count == 0 {
        return None;
    }
    for (ri, &r) in rows.iter().enumerate() {
        for &c in &children[r] {
            let k = inputs[c].get();
            if k.cell_col + k.cell_colspan > c_count || ri + k.cell_rowspan > rows.len() {
                return None;
            }
        }
    }
    Some(TableGrid { rows, row_group, caption, c_count })
}
// The border-spacing gaps around and between the columns / rows — (count + 1) of them. Zero for a
// border-COLLAPSE table (its shared edges are the cells' own halved borders, the outer ones the table's).
fn table_gaps(count: usize, sp: f64) -> f64 {
    if count == 0 { 0.0 } else { (count as f64 + 1.0) * sp }
}
// Each column's sizing inputs — the oracle's `tableColumns`. `min` / `max` are the widest its cells NEED and
// WANT (their own `intrinsic_widths`, so a cell's declared width and min/max-width already speak there); `spec`
// is the width a column was GIVEN by a cell's declared LENGTH and `pct` the fraction a `%` gave it, 0 for
// neither — either makes the column "constrained", taking no part in sharing out space beyond max-content. A
// cell that SPANS columns sizes none of them on its own: it only tops up whatever the ones it covers are short
// of (`distribute_span`), the spacing it swallows discounted.
struct TableCols {
    min: Vec<f64>,
    max: Vec<f64>,
    spec: Vec<f64>,
    pct: Vec<f64>,
}
// A table's COLUMNS as the walk marshalled them on its side-channel (`grid_start`): how many there are — the
// oracle's count, which a `<col>` / `<colgroup span>` raises past the cells' own reach — and what each one was
// DECLARED, as the px length (NaN for none) and the `%` fraction (0 for none) a `<col>` gave it. `None` for a
// table with no channel (one built without a walk — the unit tests): the caller then counts the columns the
// cells reach and takes no `<col>` declaration.
struct TableColumnDecls {
    count: usize,
    spec: Vec<f64>,
    pct: Vec<f64>,
}
fn table_col_decls(n: &Input, grids: &[f64]) -> Option<TableColumnDecls> {
    if n.grid_start < 0 {
        return None;
    }
    let at = n.grid_start as usize;
    if at >= grids.len() {
        return None;
    }
    let count = grids[at] as usize;
    if count == 0 || at + 1 + 2 * count > grids.len() {
        return None;
    }
    let mut spec = Vec::with_capacity(count);
    let mut pct = Vec::with_capacity(count);
    for ci in 0..count {
        spec.push(grids[at + 1 + 2 * ci]);
        pct.push(grids[at + 2 + 2 * ci]);
    }
    Some(TableColumnDecls { count, spec, pct })
}
fn table_columns(
    g: &TableGrid,
    sp_x: f64,
    col_decls: Option<&TableColumnDecls>,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<TableCols> {
    let n = g.c_count;
    let mut cols = TableCols { min: vec![0.0; n], max: vec![0.0; n], spec: vec![0.0; n], pct: vec![0.0; n] };
    let mut spans: Vec<(usize, usize, f64, f64)> = Vec::new(); // (col, colspan, min, max)
    for &r in &g.rows {
        for &c in &children[r] {
            let k = inputs[c].get();
            let (imin, imax) = if is_auto(k.cell_min_content) {
                intrinsic_widths(c, inputs, runs, run_texts, grids, children)?
            } else {
                (k.cell_min_content, k.cell_max_content) // the oracle's contribution: native can't measure this cell
            };
            if k.cell_colspan > 1 {
                spans.push((k.cell_col, k.cell_colspan, imin, imax));
                continue;
            }
            let col = k.cell_col;
            cols.min[col] = cols.min[col].max(imin);
            cols.max[col] = cols.max[col].max(imax);
            if !is_auto(k.cell_pct) {
                cols.pct[col] = cols.pct[col].max(k.cell_pct);
            } else if !is_auto(k.decl_w) {
                cols.spec[col] = cols.spec[col].max(imax);
            }
        }
    }
    // A `<col>` names the column instead of a cell, so it carries no padding of its own: its length / fraction
    // constrains the column just as a cell's declaration does.
    if let Some(d) = col_decls {
        for ci in 0..n.min(d.count) {
            if !is_auto(d.spec[ci]) {
                cols.spec[ci] = cols.spec[ci].max(d.spec[ci]);
            }
            if d.pct[ci] > 0.0 {
                cols.pct[ci] = cols.pct[ci].max(d.pct[ci]);
            }
        }
    }
    for &(col, span, smin, smax) in &spans {
        let inner = (span as f64 - 1.0) * sp_x; // the spacing a span covers is width it doesn't need
        distribute_span(&mut cols.min, col, span, smin - inner);
        distribute_span(&mut cols.max, col, span, smax - inner);
    }
    Some(cols)
}
// Share a spanning cell's shortfall over the columns it covers, in proportion to what they already want
// (equally when they want nothing at all).
fn distribute_span(widths: &mut [f64], start: usize, span: usize, required: f64) {
    let end = (start + span).min(widths.len());
    if end <= start {
        return;
    }
    let total: f64 = widths[start..end].iter().sum();
    let deficit = required - total;
    if deficit <= 0.0 {
        return;
    }
    let count = (end - start) as f64;
    for w in widths[start..end].iter_mut() {
        *w += if total > 0.0 { deficit * (*w / total) } else { deficit / count };
    }
}
// CSS Tables 3 §"Distributing width to columns" — a ladder of guesses, each a wider table than the last, with
// the assignable width interpolated between whichever two it falls between: min-content (every column at its
// minimum), specified-width (…and the columns GIVEN a width or a percentage raised to it), max-content (…and
// every remaining column raised to its maximum), beyond (the surplus shared over the columns given neither).
// The oracle's `distributeColumns`, Chrome-exact on every branch.
fn distribute_columns(cols: &TableCols, assignable: f64) -> Vec<f64> {
    let n = cols.min.len();
    if n == 0 {
        return Vec::new();
    }
    let min_sum: f64 = cols.min.iter().sum();
    if assignable <= min_sum {
        return cols.min.clone();
    }
    // A percentage column is only now resolvable: its basis is the width being shared out, not the table's own
    // box (Chrome: `width: 25%` of a 400px table is 98.5 — a quarter of the 394 left after border-spacing).
    let specified: Vec<f64> = (0..n).map(|i| cols.min[i].max(cols.spec[i]).max(cols.pct[i] * assignable)).collect();
    let maxes: Vec<f64> = (0..n).map(|i| cols.max[i].max(specified[i])).collect();
    let spec_sum: f64 = specified.iter().sum();
    let max_sum: f64 = maxes.iter().sum();
    if assignable <= spec_sum {
        let ratio = (assignable - min_sum) / (spec_sum - min_sum);
        return (0..n).map(|i| cols.min[i] + (specified[i] - cols.min[i]) * ratio).collect();
    }
    if assignable <= max_sum {
        let ratio = (assignable - spec_sum) / (max_sum - spec_sum);
        return (0..n).map(|i| specified[i] + (maxes[i] - specified[i]) * ratio).collect();
    }
    let surplus = assignable - max_sum;
    let growable: Vec<f64> = (0..n).map(|i| if cols.spec[i] > 0.0 || cols.pct[i] > 0.0 { 0.0 } else { maxes[i] }).collect();
    let basis: f64 = growable.iter().sum();
    if basis > 0.0 {
        return (0..n).map(|i| maxes[i] + surplus * (growable[i] / basis)).collect();
    }
    if max_sum > 0.0 {
        return maxes.iter().map(|m| m + surplus * (m / max_sum)).collect();
    }
    vec![assignable / n as f64; n]
}
// `table-layout: fixed` (§17.5.2): the columns come from the FIRST ROW alone — a `<col>` width, then a
// first-row cell's declared width (a border box: the column holds the whole cell, so a content-box declaration
// takes the cell's own horizontal edges; a colspan splits it evenly) — and whatever is left is shared EQUALLY
// among the columns that named nothing. Content never enters into it, which is the whole point: the table lays
// out without measuring any of it, and a cell's text wraps to its column instead of the column growing to the
// text. With NO auto column the leftover is spread PROPORTIONALLY over the declared widths (Chrome: two 50px
// columns in a 300px fixed table are 144 each) — equally when they are all 0 — so the columns always FILL the
// table; columns that OVERFLOW it keep their widths and the table grows around them instead.
fn fixed_column_widths(
    g: &TableGrid,
    col_decls: Option<&TableColumnDecls>,
    assignable: f64,
    inputs: &[Cell<Input>],
    children: &[Vec<usize>],
) -> Vec<f64> {
    let n = g.c_count;
    let mut widths: Vec<Option<f64>> = (0..n)
        .map(|ci| {
            let d = col_decls.filter(|d| ci < d.count)?;
            if d.pct[ci] > 0.0 {
                Some(d.pct[ci] * assignable)
            } else if !is_auto(d.spec[ci]) {
                Some(d.spec[ci])
            } else {
                None
            }
        })
        .collect();
    for &c in &children[g.rows[0]] {
        let k = inputs[c].get();
        let declared = if !is_auto(k.cell_pct) {
            k.cell_pct * assignable
        } else if !is_auto(k.decl_w) {
            k.decl_w
        } else {
            continue;
        };
        let border = if k.decl_border_box { declared } else { declared + k.edges_x() };
        let each = border / k.cell_colspan as f64;
        for ci in k.cell_col..(k.cell_col + k.cell_colspan).min(n) {
            if widths[ci].is_none() {
                widths[ci] = Some(each);
            }
        }
    }
    let used: f64 = widths.iter().filter_map(|w| *w).sum();
    let autos = widths.iter().filter(|w| w.is_none()).count();
    if autos > 0 {
        let share = (assignable - used).max(0.0) / autos as f64;
        return widths.iter().map(|w| w.unwrap_or(share)).collect();
    }
    let extra = assignable - used;
    if extra <= 0.0 {
        return widths.iter().map(|w| w.unwrap_or(0.0)).collect();
    }
    if used > 0.0 {
        return widths.iter().map(|w| { let v = w.unwrap_or(0.0); v + extra * (v / used) }).collect();
    }
    vec![assignable / n as f64; n]
}

// A table's own (min-content, max-content) BORDER-box widths — the oracle's `tableIntrinsicWidths`, the answer
// `intrinsic_widths` gives for a table (its rows are not blocks to be measured one at a time). Each column
// contributes its minimum / maximum, floored by the LENGTH a `<col>` or a cell gave it, plus the frame (the
// gaps and the table's own border + padding). A PERCENTAGE column widens the max-content so the table can be
// wide enough for the column to BE that fraction of it — its own want divided by the fraction — and, when the
// percentages leave room, wide enough that the non-percentage columns' content is the share that remains. A
// caption's margin box spans the table's border box, so its min-content floors the whole figure.
fn table_intrinsic_widths(
    i: usize,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<(f64, f64)> {
    let n = inputs[i].get();
    let decls = table_col_decls(&n, grids);
    let g = table_grid(i, inputs, children, decls.as_ref().map_or(0, |d| d.count))?;
    let cols = table_columns(&g, n.sp_x, decls.as_ref(), inputs, runs, run_texts, grids, children)?;
    let floor = caption_floor(g.caption, inputs, runs, run_texts, grids, children)?;
    // An intrinsic CONTRIBUTION reads the table's own edges basis-less, like every other box's (the oracle's
    // `tableIntrinsicWidths` uses `edgeInsets(table, null)`).
    Some(table_min_max_with_caption(&n, &g, &cols, floor, n.decl_edges_x))
}
// The border-box width a table's CAPTION requires of it (the oracle's `captionsFloor`): the caption's margin box
// spans the table's border box (§17.4), and what it cannot be squeezed below is its own min-content contribution
// — a declared LENGTH pinning it, a `%` one indefinite while the table's width is still being decided, the
// min/max-width clamping it (native declines a caption margin, so the border box is the margin box). The oracle's
// figure where native cannot measure the caption; 0 without one.
fn caption_floor(
    caption: Option<usize>,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<f64> {
    match caption {
        Some(cap) if !is_auto(inputs[cap].get().cell_min_content) => Some(inputs[cap].get().cell_min_content),
        Some(cap) => Some(intrinsic_widths(cap, inputs, runs, run_texts, grids, children)?.0),
        None => Some(0.0),
    }
}
// …from columns already measured: the figure `measure_table` needs, where the frame carries the table's edges as
// the box uses them (RESOLVED) rather than as an intrinsic contribution reads them (basis-less), and the caption's
// floor is applied by the caller.
fn table_min_max(n: &Input, g: &TableGrid, cols: &TableCols) -> (f64, f64) {
    table_min_max_with_caption(n, g, cols, 0.0, n.edges_x())
}
fn table_min_max_with_caption(n: &Input, g: &TableGrid, cols: &TableCols, floor: f64, edges: f64) -> (f64, f64) {
    let frame = table_gaps(g.c_count, n.sp_x) + edges;
    let (mut min_sum, mut max_sum, mut sum_pct, mut non_pct_max, mut pct_implied) = (0.0, 0.0, 0.0, 0.0, 0.0f64);
    for ci in 0..g.c_count {
        min_sum += cols.min[ci].max(cols.spec[ci]);
        let cmax = cols.max[ci].max(cols.spec[ci]);
        max_sum += cmax;
        if cols.pct[ci] > 0.0 {
            sum_pct += cols.pct[ci];
            pct_implied = pct_implied.max(cmax.max(cols.min[ci]) / cols.pct[ci]);
        } else {
            non_pct_max += cmax;
        }
    }
    let mut pct_max = pct_implied;
    if sum_pct > 0.0 && sum_pct < 1.0 {
        pct_max = pct_max.max(non_pct_max / (1.0 - sum_pct));
    }
    ((min_sum + frame).max(floor), (max_sum + frame).max(pct_max + frame).max(floor))
}

fn measure_table(
    i: usize,
    w: f64,
    imposed_h: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> MInfo {
    let n = inputs[i].get().with_imposed_height(imposed_h);
    let (sx, sy) = (n.sp_x, n.sp_y);
    let bail = |failed: &std::cell::Cell<bool>| {
        failed.set(true);
        MInfo { top: CMargin::of(0.0), top_only: CMargin::of(0.0), bottom: CMargin::of(0.0), collapse_through: false }
    };

    // The row / column structure the walk emitted (`table_grid`) and every column's sizing inputs from the
    // cells' own intrinsic widths (`table_columns`).
    let decls = table_col_decls(&n, grids);
    let g = match table_grid(i, inputs, children, decls.as_ref().map_or(0, |d| d.count)) {
        Some(g) => g,
        None => return bail(failed),
    };
    let (rows, row_group, caption, c_count) = (&g.rows, &g.row_group, g.caption, g.c_count);
    let r_count = rows.len();
    // `table-layout: fixed` sizes the columns from the first row's declarations alone, so it measures NO cell —
    // the per-column min/max-content pass is only for the content algorithm.
    let fixed = n.table_fixed && !is_auto(n.width);
    let cols = if fixed {
        None
    } else {
        match table_columns(&g, sx, decls.as_ref(), inputs, runs, run_texts, grids, children) {
            Some(c) => Some(c),
            None => return bail(failed),
        }
    };

    // A CAPTION (§17.4 — a block box spanning the table WRAPPER) that needs more than the table floors its
    // border-box width, so the columns share out what is left inside that.
    let cap_floor = match caption_floor(caption, inputs, runs, run_texts, grids, children) {
        Some(v) => v,
        None => return bail(failed),
    };
    // The table's own used width (§17.5.2): a declared one wins, an AUTO one SHRINK-TO-FITS its columns within
    // the room on offer — unless the box was handed to it (a grid area, a flex item, an out-of-flow inset box),
    // where `w` already is the used border box. A table whose columns then OVERFLOW that width simply grows:
    // it self-sizes from its tracks below, rather than letting the cells spill out of the box that is supposed
    // to contain them.
    let border_w = if n.self_sizes && is_auto(n.width) {
        // Its own min/max-content (a fixed table never reaches here: it has a declared width).
        let (imin, imax) = match cols.as_ref().map(|c| table_min_max(&n, &g, c)) {
            Some(v) => v,
            None => return bail(failed),
        };
        used_width(&n, imin.max(w.min(imax)))
    } else {
        w
    };
    let content_w = n.content_w(border_w.max(cap_floor));
    let gaps = table_gaps(c_count, sx);
    let assignable = (content_w - gaps).max(0.0);
    let col_w = match &cols {
        Some(c) => distribute_columns(c, assignable),
        None => fixed_column_widths(&g, decls.as_ref(), assignable, inputs, children),
    };

    // Then each cell's subtree, at its COLUMN (span) width and with NO height imposed — what its content comes
    // to is what the rows are sized from below — in a fresh float context. The cell's own declared width does not
    // speak here: it already did, when the column was sized.
    let span_w = |c: usize| -> f64 {
        let k = inputs[c].get();
        let last = k.cell_col + k.cell_colspan - 1; // `table_grid` validated the span against the column count
        let mut wsum = col_w[k.cell_col];
        for ci in (k.cell_col + 1)..=last {
            wsum += sx + col_w[ci];
        }
        wsum
    };
    for &r in rows {
        for &c in &children[r] {
            let cw = span_w(c);
            measure(c, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        }
    }

    // ROW heights (§17.5.3). A row is as tall as the tallest cell that does NOT span rows — each cell's own box,
    // its declared height already a floor and its min/max applied (`height_is_floor`) — floored by what the row
    // itself declared. A cell aligned on the BASELINE contributes differently: the row's baseline is the deepest
    // first-baseline among those cells, each then drops so its own baseline reaches it, and the row must hold the
    // lowest resulting cell bottom — so those are deferred until the row's baseline is known. A cell that SPANS
    // rows sizes none of them on its own: it joins its FIRST row's baseline group, and whatever the rows it
    // covers come up short of grows the LAST one it touches.
    // A PERCENTAGE row height resolves against what the rows share out — the imposed content height less the
    // spacing around and between them — and only when that height is definite; the percentages are taken in
    // RENDER order (header, body, footer — the order the rows arrive in) and cannot overflow the basis (Chrome
    // squeezes a later one into what is left).
    let imposed_h = {
        let to_content = |v: f64| if n.border_box { (v - n.edges_y()).max(0.0) } else { v };
        let declared = if is_auto(n.height) { 0.0 } else { to_content(n.height) };
        let capped = if is_auto(n.max_h) { declared } else { declared.min(to_content(n.max_h)) };
        if is_auto(n.min_h) { capped } else { capped.max(to_content(n.min_h)) }
    };
    let row_pct_basis = if imposed_h > 0.0 { (imposed_h - table_gaps(r_count, sy)).max(0.0) } else { f64::NAN };
    let mut row_h = vec![0.0f64; r_count];
    let mut row_declared = vec![false; r_count];
    let mut row_baseline = vec![0.0f64; r_count];
    let mut spans: Vec<(usize, usize)> = Vec::new(); // (cell, its first row) — sized when it ENDS
    let mut row_seen = vec![false; r_count];
    let mut pct_used = 0.0f64;
    for (ri, &r) in rows.iter().enumerate() {
        let rn = inputs[r].get();
        let declared = if !is_auto(rn.row_pct) && !is_auto(row_pct_basis) {
            let take = (rn.row_pct * row_pct_basis).min(row_pct_basis - pct_used).max(0.0);
            pct_used += take;
            Some(take)
        } else if !is_auto(rn.row_height) {
            Some(rn.row_height)
        } else {
            None
        };
        row_declared[ri] = declared.is_some();
        let mut h = declared.unwrap_or(0.0);
        let mut baseline_cells: Vec<usize> = Vec::new();
        for &c in &children[r] {
            let k = inputs[c].get();
            // A cell aligned on the baseline joins this row's group — a spanning one too, for the baseline alone.
            let base = if k.cell_valign == 0 { boxes[c].first_baseline } else { None };
            if let Some(b) = base {
                row_baseline[ri] = row_baseline[ri].max(b);
            }
            if k.cell_rowspan > 1 {
                spans.push((c, ri));
                continue;
            }
            row_seen[ri] = true;
            if base.is_some() {
                baseline_cells.push(c);
            } else {
                h = h.max(boxes[c].h);
            }
        }
        // …and now the baseline cells: each one's content drops by (row baseline − its own), and the row grows to
        // hold the lowest bottom that makes — a box floored taller than its content keeps that height either way.
        for c in baseline_cells {
            let base = boxes[c].first_baseline.unwrap_or(0.0);
            let nat = boxes[c].natural_h.unwrap_or(boxes[c].h);
            h = h.max(boxes[c].h).max((row_baseline[ri] - base) + nat);
        }
        row_h[ri] = h;
        // A spanning cell that ENDS on this row grows it by whatever the rows it covers are short of.
        for &(c, start) in spans.iter() {
            let end = (start + inputs[c].get().cell_rowspan - 1).min(r_count - 1);
            if end != ri {
                continue;
            }
            let have: f64 = (start..ri).map(|k| row_h[k] + sy).sum();
            row_h[ri] = row_h[ri].max(boxes[c].h - have);
        }
    }
    if row_seen.iter().any(|&s| !s) {
        return bail(failed); // a row whose cells all span rows — no height to read
    }

    // A declared table height TALLER than the grid is shared out over the rows — a click aimed at the visible
    // bottom of a cell has to land inside it. The surplus goes to the BODY group's AUTO rows in proportion to
    // their content (Chrome: rows of 10 and 30 in a 100px table become 25 and 75, and a declared-height row keeps
    // its height and takes none); a header / footer row is held at its natural height. Failing any body auto row
    // it goes to the body's declared rows, then to any auto row, then to every row by height.
    if imposed_h > 0.0 {
        let grid_h: f64 = row_h.iter().sum::<f64>() + table_gaps(r_count, sy);
        let room = imposed_h - grid_h;
        if room > 0.0 {
            let body: Vec<usize> = (0..r_count).filter(|&i| inputs[rows[i]].get().row_rank == 1).collect();
            let body_autos: Vec<usize> = body.iter().copied().filter(|&i| !row_declared[i]).collect();
            let autos: Vec<usize> = (0..r_count).filter(|&i| !row_declared[i]).collect();
            let targets = if !body_autos.is_empty() {
                body_autos
            } else if !body.is_empty() {
                body
            } else if !autos.is_empty() {
                autos
            } else {
                (0..r_count).collect()
            };
            let weight: f64 = targets.iter().map(|&i| row_h[i]).sum();
            for &i in &targets {
                row_h[i] += if weight > 0.0 { room * (row_h[i] / weight) } else { room / targets.len() as f64 };
            }
        }
    }

    // border-collapse:collapse (§17.6.2) needs no special frame here: the oracle folds each shared edge into
    // one border split between the two cells, and the table's OWN border (`n.bl`/`n.bt`/`n.br`/`n.bb`, pushed
    // from `edgeInsets`) is already the outer half of its rim cells' collapsed borders, with no padding. So a
    // collapse table self-sizes from its tracks + edges exactly like a separate one — only with border-spacing
    // 0 and the halved borders the oracle pushed.
    // The table (WRAPPER) SELF-sizes from its grid tracks + spacing plus its own edges — not the width its parent
    // passed — floored by what its caption requires. (Separate: spacing > 0. Collapse: spacing is 0 and the edges
    // are the outer-half frame.)
    let sum_col: f64 = col_w.iter().sum();
    let sum_row: f64 = row_h.iter().sum();
    let grid_w = sum_col + (c_count as f64 + 1.0) * sx;
    let grid_h = sum_row + (r_count as f64 + 1.0) * sy;
    let table_w = (grid_w + n.edges_x()).max(cap_floor);
    // The caption is a block box laid out in that BORDER box, outside the table's own border+padding (§17.4
    // wrapper box): an auto width fills it, a declared one (a `%` of it) is its own and may overflow it without
    // growing the table, and a `%` height resolves against the table's definite height. The `<table>` el._lb is
    // the WRAPPER (caption + grid): a caption-side:top caption offsets the whole grid down by its height; a bottom
    // one sits below the grid (placed below).
    if let Some(cap) = caption {
        let h_basis = n.definite_content_h().map_or(f64::NAN, |h| h + n.edges_y());
        let k = inputs[cap].get().with_percent_sizes(table_w, h_basis);
        inputs[cap].set(k);
        measure(cap, resolve_width(&k, table_w), f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
    }
    let caption_h = caption.map(|cap| boxes[cap].h).unwrap_or(0.0);
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

    boxes[i].nid = n.nid;
    boxes[i].w = table_w;
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
        if inputs[ch].get().display != DISPLAY_TABLE_ROW_GROUP {
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
            boxes[ch].nid = inputs[ch].get().nid;
            boxes[ch].x = row_x;
            boxes[ch].y = row_top[f];
            boxes[ch].w = row_w;
            boxes[ch].h = row_top[last] + row_h[last] - row_top[f];
            boxes[ch].auto_height = false;
        }
    }

    // Row boxes (relative to their parent: the group box, else the table) + cell positions (relative to the
    // row). A cell FILLS the rows it spans — that box, not its content's, is what a click has to land in — and
    // its content then sits within it per `vertical-align` (§17.5.3): `baseline` drops it so the cell's own first
    // baseline meets the row's, `middle` / `bottom` take half / all of the slack the row is taller than the
    // content by (the content's NATURAL height, not the floored box — a `middle` cell whose declared height
    // already exceeds its content still centres that content). The box stays at the row top either way, so the
    // shift moves the cell's own children (their subtrees follow through `place`).
    for (ri, &r) in rows.iter().enumerate() {
        let (gx, gy) = match row_group[ri] {
            Some(g) => (boxes[g].x, boxes[g].y),
            None => (0.0, 0.0),
        };
        boxes[r].nid = inputs[r].get().nid;
        boxes[r].x = row_x - gx;
        boxes[r].y = row_top[ri] - gy;
        boxes[r].w = row_w;
        boxes[r].h = row_h[ri];
        boxes[r].auto_height = false;
        for &c in &children[r] {
            let k = inputs[c].get();
            let (col, rs) = (k.cell_col, k.cell_rowspan);
            let content_h = boxes[c].natural_h.unwrap_or(boxes[c].h);
            let h = row_h[ri..ri + rs].iter().sum::<f64>() + (rs as f64 - 1.0) * sy;
            let shift = match k.cell_valign {
                0 => (row_baseline[ri] - boxes[c].first_baseline.unwrap_or(row_baseline[ri])).max(0.0),
                2 | 3 if h - content_h > 0.01 => {
                    let slack = h - content_h;
                    if k.cell_valign == 3 { slack } else { slack / 2.0 }
                }
                _ => 0.0,
            };
            boxes[c].h = h;
            // The cell's position within the row (relative to it). An rtl table (r2) MIRRORS its columns —
            // column 0 is rightmost — so the cell's box is reflected within the row width: rel = row_w - ltr_rel
            // - cell_width (a colspan reflects by its own spanned width; the row / group / table boxes span the
            // whole grid and are direction-agnostic).
            let ltr_rel = col_x[col] - row_x;
            boxes[c].x = if n.rtl != 0 { row_w - ltr_rel - boxes[c].w } else { ltr_rel };
            boxes[c].y = 0.0;
            if shift > 0.0 {
                for &ch in &children[c] {
                    // …but not a REPLAYED out-of-flow child: its box comes from the oracle's own displacement
                    // (`rel_y`, applied in `place`), which already carries the shift. One native positions itself
                    // does move with the content, since its static position is the cell's flow.
                    let cn = inputs[ch].get();
                    if cn.out_of_flow != 0 && !cn.native_oof() {
                        continue;
                    }
                    boxes[ch].y += shift;
                }
            }
        }
    }

    let top = CMargin::of(Input::m(n.mt));
    MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false }
}

// One column of a computed grid's template (§12.4), decoded from `grids` at 7 values per column: `(base_kind,
// base_val, limit_kind, limit_val, is_fr, fr_weight, is_auto)`. A SIDE (the track's base or its limit) is either a
// px figure (kind 0: fixed / %-resolved — or an intrinsic side the oracle already resolved, the fallback when
// native can't measure an item) or an intrinsic reference native resolves from the column's content
// contribution: kind 1 = the column's min-content, 2 = its max-content, 3 = `fit-content(val)` = max-content
// capped at `val`, never below min-content. The kinds mirror the oracle's `trackSideSpec`.
#[derive(Clone, Copy)]
struct GridTrack {
    base_kind: u8,
    base_val: f64,
    limit_kind: u8,
    limit_val: f64,
    is_fr: bool,
    fr_weight: f64,
    is_auto: bool,
}
const GRID_TRACK_STRIDE: usize = 7;
// A grid's header in `grids`: column count, column gap (px, fraction), row gap (px, fraction), declared row height.
const GRID_HEADER: usize = 6;
impl GridTrack {
    fn decode(grids: &[f64], o: usize) -> GridTrack {
        GridTrack {
            base_kind: grids[o] as u8,
            base_val: grids[o + 1],
            limit_kind: grids[o + 2] as u8,
            limit_val: grids[o + 3],
            is_fr: grids[o + 4] != 0.0,
            fr_weight: grids[o + 5],
            is_auto: grids[o + 6] != 0.0,
        }
    }
    fn needs_content(&self) -> bool {
        !matches!(self.base_kind, 0 | 4) || !matches!(self.limit_kind, 0 | 4)
    }
}
// One side of a track in px, given the column's (min, max) content contribution — the oracle's `resolveSideSpec` —
// and the grid's content width, which a PERCENTAGE side is a fraction of (kind 4; kind 5 is `fit-content` capped
// at such a fraction).
fn resolve_track_side(kind: u8, val: f64, col: (f64, f64), content_w: f64) -> f64 {
    match kind {
        1 => col.0,
        2 => col.1,
        4 => val * content_w,
        5 => col.0.max((val * content_w).min(col.1)),
        3 => col.0.max(val.min(col.1)),
        _ => val,
    }
}

// The column widths a computed grid hands its items (§12.4-12.7). Each track's base and limit resolve from its
// spec (a px figure, or an intrinsic reference into `cols`, the per-column content contributions — `None` when
// no track asks for one). Native then runs the two distributions: §12.6 "maximize" grows the non-fr tracks
// toward their limits sharing free space equally, then §12.7 hands the remainder to the `fr` tracks (weight
// sum floored at 1, floors refrozen), or — with no `fr` — stretches the `auto` tracks to fill
// (`justify-content: normal`).
fn grid_column_widths(tracks: &[GridTrack], cols: Option<&[(f64, f64)]>, content_w: f64, col_gap: f64) -> Vec<f64> {
    let col_count = tracks.len();
    let inner = content_w - col_gap * (col_count as f64 - 1.0).max(0.0);
    let mut base = vec![0.0f64; col_count];
    let mut limit = vec![0.0f64; col_count];
    for (c, t) in tracks.iter().enumerate() {
        let col = cols.map(|cs| cs[c]).unwrap_or((0.0, 0.0));
        base[c] = resolve_track_side(t.base_kind, t.base_val, col, content_w);
        limit[c] = if t.is_fr { base[c] } else { resolve_track_side(t.limit_kind, t.limit_val, col, content_w) };
    }
    let mut free = inner - base.iter().sum::<f64>();
    // §12.6 "maximize tracks": grow the intrinsic (non-fr, limit > base) tracks toward their limits, sharing what
    // is free equally; a negative free space grows nothing (the grid overflows, as a browser lets it).
    if free > 0.01 {
        let mut growable: Vec<usize> = (0..col_count).filter(|&c| !tracks[c].is_fr && limit[c] > base[c]).collect();
        while free > 0.01 && !growable.is_empty() {
            let share = free / growable.len() as f64;
            let mut next = Vec::new();
            for &c in &growable {
                let add = (limit[c] - base[c]).min(share);
                base[c] += add;
                free -= add;
                if limit[c] - base[c] > 0.01 {
                    next.push(c);
                }
            }
            if next.len() == growable.len() && share <= 0.01 {
                break;
            }
            growable = next;
        }
    }
    // §12.7 "find the size of an fr": `fr` divides `inner` less the (grown) non-fr tracks — its own floor is NOT
    // subtracted first, but is a minimum its share can't fall below (a floor that beats its share refreezes and
    // leaves the pool). A weight sum below 1 is NOT scaled up.
    let fr_idx: Vec<usize> = (0..col_count).filter(|&c| tracks[c].is_fr).collect();
    if !fr_idx.is_empty() {
        let taken: f64 = (0..col_count).filter(|&c| !tracks[c].is_fr).map(|c| base[c]).sum();
        let mut flexible = fr_idx;
        let mut spare = (inner - taken).max(0.0);
        loop {
            let weight = flexible.iter().map(|&c| tracks[c].fr_weight).sum::<f64>().max(1.0);
            let frozen: Vec<usize> = flexible.iter().copied().filter(|&c| base[c] > spare * tracks[c].fr_weight / weight).collect();
            if frozen.is_empty() {
                for &c in &flexible {
                    base[c] = base[c].max(spare * tracks[c].fr_weight / weight);
                }
                break;
            }
            for &c in &frozen {
                spare = (spare - base[c]).max(0.0);
            }
            flexible.retain(|c| !frozen.contains(c));
            if flexible.is_empty() {
                break;
            }
        }
    } else if free > 0.01 {
        // No `fr` to absorb the remainder: `auto` tracks stretch to fill the row (the `justify-content: normal`
        // default behaves as `stretch` for them); a fixed-only list keeps its sizes and leaves the remainder.
        let autos: Vec<usize> = (0..col_count).filter(|&c| tracks[c].is_auto).collect();
        if !autos.is_empty() {
            let extra = free / autos.len() as f64;
            for &c in &autos {
                base[c] += extra;
            }
        }
    }
    base.iter().map(|&w| w.max(0.0)).collect()
}

// One item's place in a computed grid: its first column, its span, and its row (consecutive items on
// different rows are separated by exactly one row advance).
#[derive(Clone, Copy)]
struct GridCell {
    col: usize,
    span: usize,
    row: usize,
}
// Row-major auto-placement, mirroring the oracle (`layoutGrid` / `gridColumnContent` agree on the columns): an
// explicit start that fits resets the column (a new row if the cursor already passed it); otherwise a span that
// would overflow wraps; a filled row advances at once. `grids[place_base + 2k ..]` holds item k's (col-start or
// -1, span). Shared by the content measure (which columns an item contributes to) and the layout (where it lands).
fn grid_placement(grids: &[f64], place_base: usize, col_count: usize, n_items: usize) -> Vec<GridCell> {
    let mut cells = Vec::with_capacity(n_items);
    let mut col = 0usize;
    let mut row = 0usize;
    for k in 0..n_items {
        let start_f = grids[place_base + 2 * k];
        let span = (grids[place_base + 2 * k + 1] as usize).clamp(1, col_count);
        if start_f >= 0.0 && (start_f as usize) + span <= col_count {
            let start = start_f as usize;
            if start < col {
                row += 1; // the row already passed this line → open a new one
            }
            col = start;
        } else if col + span > col_count {
            row += 1; // the span would overflow the row → wrap
            col = 0;
        }
        cells.push(GridCell { col, span, row });
        col += span;
        if col >= col_count {
            row += 1;
            col = 0;
        }
    }
    cells
}

// Each column's (min, max) content contribution: the widest item placed in it — a spanning item's contribution
// divided EVENLY across its columns (the coarse oracle's `gridColumnContent`). `None` when an item's intrinsic
// widths aren't natively measurable (the JS gate should have routed such a grid to the resolved-px fallback; this
// is the safety net that declines the pass rather than lay out a wrong column).
fn grid_column_content(
    kids: &[usize],
    cells: &[GridCell],
    col_count: usize,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<Vec<(f64, f64)>> {
    let mut cols = vec![(0.0f64, 0.0f64); col_count];
    for (k, &c) in kids.iter().enumerate() {
        let cell = cells[k];
        let (min, max) = intrinsic_widths(c, inputs, runs, run_texts, grids, children)?;
        let span = cell.span as f64;
        for col in cols.iter_mut().skip(cell.col).take(cell.span) {
            col.0 = col.0.max(min / span);
            col.1 = col.1.max(max / span);
        }
    }
    Some(cols)
}

// A box's (min-content, max-content) BORDER-box widths — CSS Sizing 3's intrinsic contribution, the oracle's
// `intrinsicWidths` on the record tree. A declared width pins both (border-box per `box-sizing`); a text block
// measures its inline content (`text_intrinsic`); a block container is as wide as its widest child's margin
// box, for min and max alike; a flex container stacks its items along its main axis (`flex_intrinsic_widths`);
// a TABLE runs its own column algorithm (`table_intrinsic_widths`, which answers a border box unclamped, as the
// oracle's early return does); then the box's own edges add on and its min/max-width clamp the contribution
// (border-box per `box-sizing`, min winning over max). EVERY figure read is the record's DECLARED, BASIS-LESS
// one — the sizes in `decl_*`, the horizontal edges in `decl_edges_x` / `decl_margin_x` — because a percentage
// resolves against nothing in an intrinsic measure (CSS Sizing 3, and the oracle's `edgeInsets(el, null)`),
// never the used box a push may have written nor the cbW-resolved edges a laid-out box uses. Floats pack on a
// line inside a block container as inline boxes would. `None` for what isn't measured: a replayed grid, a pushed
// atomic inline, an unmodelled run.
// `intrinsic_widths` is a pure function of the RECORD TREE's DECLARED sizing, which no pass ever changes (a parent
// does write its children's USED sizes — their percentages resolved, `with_percent_sizes` — but no intrinsic
// measure reads those; and nothing under it touches `boxes` or `failed`) — so within one pass each node's answer is
// asked once and kept. That is the memo's contract, and a pass that ever DOES adjust a record and measure again owes
// it a clear: park or drop the memo there, the way `IwMemo` parks an outer one. Without the memo every shrink-to-fit route re-walks the whole
// subtree under it, and since `writing-mode` INHERITS, a vertical page asks for EVERY nested block: the walk
// goes O(nodes × depth) (measured: 80 records nested 48 deep took 80 ms, against 17 ms for the same tree with
// declared widths, and it scaled with DEPTH — 20 / 35 / 79 ms at depth 12 / 24 / 48).
//
// The memo exists only FOR the duration of a pass (`IwMemo::install`, dropped when `layout_block` returns or
// unwinds), which is what makes "the tree cannot change under it" true rather than hopeful — a direct caller
// outside a pass (the unit tests, which mutate their fixtures between asks) memoizes nothing.
thread_local! {
    static IW_MEMO: std::cell::RefCell<Option<Vec<Option<Option<(f64, f64)>>>>> = const { std::cell::RefCell::new(None) };
}
// The guard PARKS whatever memo was installed and restores it on the way out, so a pass nested inside another
// gets a memo of its own size rather than reading the outer pass's answers at its own indices. (No path nests
// today — Rust never calls back into JS — which is exactly why the invariant belongs in the guard.)
struct IwMemo(Option<Vec<Option<Option<(f64, f64)>>>>);
impl IwMemo {
    fn install(len: usize) -> Self {
        IwMemo(IW_MEMO.with(|m| m.borrow_mut().replace(vec![None; len])))
    }
}
impl Drop for IwMemo {
    fn drop(&mut self) {
        IW_MEMO.with(|m| *m.borrow_mut() = self.0.take());
    }
}
fn intrinsic_widths(i: usize, inputs: &[Cell<Input>], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    // The borrow is taken and released around the recursion, never across it (`intrinsic_widths_of` recurses
    // back in here). The outer Option is "asked before"; the inner one is the answer, `None` included — a
    // subtree native cannot measure is asked about as often as a measurable one.
    if let Some(hit) = IW_MEMO.with(|m| m.borrow().as_ref().and_then(|v| v.get(i).copied()).flatten()) {
        return hit;
    }
    let answer = intrinsic_widths_of(i, inputs, runs, run_texts, grids, children);
    IW_MEMO.with(|m| {
        if let Some(v) = m.borrow_mut().as_mut() {
            if let Some(slot) = v.get_mut(i) {
                *slot = Some(answer);
            }
        }
    });
    answer
}
fn intrinsic_widths_of(i: usize, inputs: &[Cell<Input>], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    let n = inputs[i].get();
    let extra = n.decl_edges_x;
    let (inner_min, inner_max) = if !is_auto(n.decl_w) {
        let w = if n.decl_border_box { (n.decl_w - extra).max(0.0) } else { n.decl_w };
        (w, w)
    } else if n.replaced && !n.ratio_only {
        (n.intrinsic_w, n.intrinsic_w) // a replaced box wants its intrinsic width (a ratio-only one, its container's)
    } else if n.display == DISPLAY_FLEX {
        flex_intrinsic_widths(i, inputs, runs, run_texts, grids, children)?
    } else if n.display == DISPLAY_TABLE {
        // A table brings its own algorithm for the same question, and its rows are not blocks to be measured one
        // at a time. That answer is already a BORDER-box figure (the frame included) and the oracle returns it
        // unclamped, so it stands as it is — no edges, no min/max-width clamp. KNOWN GAP, faithfully mirrored:
        // returning here also skips the keyword PIN below, so a `width: min-content` TABLE contributes its
        // range where Chrome contributes the one figure (`<div style="width:min-content"><table
        // style="width:max-content">aa bb cc` is 52.41 in Chrome, 16 in both engines).
        return table_intrinsic_widths(i, inputs, runs, run_texts, grids, children);
    } else {
        content_intrinsic(i, inputs, runs, run_texts, grids, children)?
    };
    // `width: min-content` / `max-content` PIN the box to that one figure (CSS Sizing 3 §5) — the box asks for
    // the same width whatever room it is offered, so both of an ancestor's figures see it; `fit-content` leaves
    // the range, and the room decides between them. (A keyword is basis-independent, so the same bit that
    // resolved the used width answers here.)
    let (inner_min, inner_max) = match n.width_kw {
        1 => (inner_min, inner_min),
        2 => (inner_max, inner_max),
        _ => (inner_min, inner_max),
    };
    // The box's own min/max-width clamp its OUTER contribution (CSS Sizing 3 §5.1), in its box-sizing model.
    let to_border = |v: f64| if is_auto(v) || n.decl_border_box { v } else { v + extra };
    let min = clamp_min_max(inner_min + extra, to_border(n.decl_min_w), to_border(n.decl_max_w));
    let max = clamp_min_max(inner_max + extra, to_border(n.decl_min_w), to_border(n.decl_max_w));
    Some((min, max))
}

// What a box CONTAINS, as (min-content, max-content) content widths — the oracle's `contentIntrinsicWidths`:
// a text block's inline content (`text_intrinsic`); a block container's children, each contributing its
// margin box (a float packs on a line, a block-level child ends it). Asked of a FLEX container too — for a
// keyword `flex-basis` or its automatic minimum the oracle walks its children as block-level boxes (the same
// widest-child answer), not along the flex axis. No declared width, no edges, no clamp: those are
// `intrinsic_widths`' business.
fn content_intrinsic(i: usize, inputs: &[Cell<Input>], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    let n = inputs[i].get();
    match n.display {
        DISPLAY_TEXT_BLOCK => {
            let (rs, re) = (n.run_start.max(0) as usize, (n.run_start + n.run_count).max(0) as usize);
            if re > runs.len() || rs > re {
                return None;
            }
            text_intrinsic(&runs[rs..re], &run_texts[rs..re], n.ws_mode, inputs, runs, run_texts, grids, children)
        }
        _ if n.replaced => Some((0.0, 0.0)), // a replaced box holds no CSS content (a ratio-only svg asks its container)
        DISPLAY_BLOCK | DISPLAY_FLEX | DISPLAY_GRID => {
            let (mut min, mut max) = (0.0f64, 0.0f64);
            let mut line = 0.0f64; // floats pack beside each other on a line, as inline boxes would
            for &c in &children[i] {
                let k = inputs[c].get();
                if k.out_of_flow != 0 {
                    continue; // out of flow: sizes nothing
                }
                // Each child contributes its MARGIN box (a negative margin narrows it; auto is 0) — basis-less,
                // as every figure an intrinsic measure reads is.
                let (cmin, cmax) = intrinsic_widths(c, inputs, runs, run_texts, grids, children)?;
                let m = k.decl_margin_x;
                if k.float_kind != 0 {
                    // A FLOAT packs beside its neighbours like an inline-level box: its max-content joins the
                    // line, its min-content stands alone (the oracle's float arm — no line end).
                    line += cmax + m;
                    min = min.max(cmin + m);
                    continue;
                }
                // A block-level child ends the line the floats were packing, then contributes on its own.
                max = max.max(line);
                line = 0.0;
                min = min.max(cmin + m);
                max = max.max(cmax + m);
            }
            Some((min, max.max(line)))
        }
        _ => None,
    }
}

// A box's min-content WIDTH as a flex item's automatic minimum (§4.5) — the oracle's `minContentWidth`: the
// content's min-content plus the box's RESOLVED edges (this is a floor on a used size, not an intrinsic
// contribution — see the body), capped by a declared width (border-box per `box-sizing`; a percentage is auto,
// `decl_w`).
fn min_content_width(i: usize, inputs: &[Cell<Input>], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<f64> {
    let n = inputs[i].get();
    if n.replaced && !n.ratio_only {
        return Some(n.intrinsic_w); // the oracle's minContentWidth: the intrinsic width, edges not counted
    }
    // The box's own edges RESOLVED: this is a floor on a used size, not an intrinsic contribution, so a
    // percentage padding counts here as it does in the box (Chrome floors a `padding: 0 10%` item in a 100px row
    // at 52 — its text plus the 20 the padding comes to).
    let content = content_intrinsic(i, inputs, runs, run_texts, grids, children)?.0 + n.edges_x();
    if is_auto(n.decl_w) {
        return Some(content);
    }
    let declared = if n.decl_border_box { n.decl_w } else { n.decl_w + n.edges_x() };
    Some(declared.min(content))
}

// A flex container's (min-content, max-content) CONTENT widths — the oracle's `flexIntrinsicWidths`: its in-flow
// items' contributions stacked along the main axis. Along a ROW they sum, margins and the main gap between them
// (the min-content too, unless the row WRAPS — then each item may have a line to itself and the widest wins);
// down a COLUMN the widest wins. A row item's contribution is its intrinsic box, its `flex-basis` pinning it — or,
// when the item may grow, only raising its max (the coarse form of §9.9) — then its own min/max-width (border-box
// per `box-sizing`); a column item contributes the width it wants, as any block child would.
fn flex_intrinsic_widths(i: usize, inputs: &[Cell<Input>], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    let n = inputs[i].get();
    let column = !n.flex_main_is_x;
    let wrap = !column && n.flex_wrap;
    let (mut min, mut max) = (0.0f64, 0.0f64);
    let mut count = 0usize;
    for &c in &children[i] {
        let k = inputs[c].get();
        if k.out_of_flow != 0 {
            continue; // out of flow: sizes nothing
        }
        let (mut imin, mut imax) = intrinsic_widths(c, inputs, runs, run_texts, grids, children)?;
        if !column {
            // …converted with the BASIS-LESS edges, like every other figure an intrinsic measure reads (the
            // oracle's `flexIntrinsicWidths` uses `edgeInsets(child, null)`).
            let extra = if k.decl_border_box { 0.0 } else { k.decl_edges_x };
            if !is_auto(k.flex_basis) {
                let fixed = k.flex_basis + extra;
                if k.flex_grow > 0.0 {
                    imax = imax.max(fixed);
                } else {
                    imin = fixed;
                    imax = fixed;
                }
            }
            if !is_auto(k.decl_max_w) && k.decl_max_w >= 0.0 {
                imin = imin.min(k.decl_max_w + extra);
                imax = imax.min(k.decl_max_w + extra);
            }
            if !is_auto(k.decl_min_w) && k.decl_min_w >= 0.0 {
                imin = imin.max(k.decl_min_w + extra);
                imax = imax.max(k.decl_min_w + extra);
            }
        }
        let m = k.decl_margin_x;
        count += 1;
        if column {
            min = min.max(imin + m);
            max = max.max(imax + m);
        } else {
            max += imax + m;
            if wrap {
                min = min.max(imin + m);
            } else {
                min += imin + m;
            }
        }
    }
    if !column && count > 1 {
        let gaps = n.flex_main_gap * (count as f64 - 1.0);
        max += gaps;
        if !wrap {
            min += gaps;
        }
    }
    Some((min, max))
}

// The (min-content, max-content) widths of a text block's inline content — the oracle's `contentIntrinsicWidths`
// pen-walk over the same run stream `line_layout` lays out. ONE pen runs along the line: `line` is the width the
// content reaches with no soft wrap (the widest line is the MAX-content), `word` the unbreakable run since the
// last break opportunity, across run boundaries (the widest is the MIN-content); a `<br>` or a preserved newline
// ends the line. Under a COLLAPSING mode (normal / nowrap / pre-line) a run of white space is one space, content
// only once something follows it on the line — a leading one at line start is nothing, a trailing one hangs
// pending until the next word takes it (the LAST pending run's space width wins, as the oracle overwrites it) —
// and, when the mode wraps, a break opportunity; pre-line's newlines end the line. Under a PRESERVING mode (pre /
// pre-wrap) every space is content on the line, an opportunity only when the mode wraps. A mode that never wraps
// (nowrap / pre) pins the min-content to the max-content. An inline element's EDGES (OPEN / CLOSE) are content
// on the line and in the word — and an inline with any edge takes the pending space at its open (the oracle
// reads its close edge there too). `<wbr>` is a bare opportunity. A run under `word-break: break-all` /
// `overflow-wrap: anywhere` (wrap mode 1 / 3) breaks between ANY two characters for the min-content: each
// character's UNSPACED advance is a unit of its own (the oracle's `charAdvances` — letter/word-spacing is left
// out of both figures there); `break-word` (2) leaves the measure alone. An atomic inline native lays
// out itself contributes its own intrinsic widths (plus margins) as one unbreakable unit with an opportunity on
// each side. `None` for a PUSHED atomic (its box is not in the stream), a tab / other control, or a ZWJ under
// per-character breaking (the oracle's per-character advance carries the previous character).
fn text_intrinsic(runs: &[Run], run_texts: &[Option<Vec<u16>>], ws_mode: u8, inputs: &[Cell<Input>], all_runs: &[Run], all_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    // …per RUN, because an inline may declare its own `white-space` (`Run::ws_mode`) and every one of these is
    // about the run it belongs to. `pin` is the exception: "this box never wraps, so its min-content IS its
    // max-content" is a statement about the whole stream, true only while no run in it wraps.
    let modes = |m: u8| match m {
        0 => Some((true, false, false)),   // normal:   wraps, collapses, no forced newline
        1 => Some((false, false, false)),  // nowrap
        2 => Some((false, true, true)),    // pre
        3 => Some((true, true, true)),     // pre-wrap
        4 => Some((true, false, true)),    // pre-line
        _ => None,
    };
    // `pin` — "this box never wraps, so its min-content IS its max-content" — is the BLOCK's, not the runs':
    // the oracle ends `contentIntrinsicWidths` with `NON_WRAPPING_WS.has(whiteSpaceOf(el))`, asked of the
    // ELEMENT. A wrapping inline inside a `nowrap` block does not unpin it.
    let pin = !modes(ws_mode)?.0;
    // …while the three behaviours are set from each RUN's own mode as the loop reaches it.
    let (mut wraps, mut preserve, mut break_nl);
    let (mut min, mut max) = (0.0f64, 0.0f64);
    // (No `text-indent` here: the WALK declines an indented block whose intrinsic widths native would be asked
    // for, because what Chrome's min-content does with an indent is a real break pass at zero available width —
    // see the walk's own note. The FLOW applies it, in `line_layout`.)
    let (mut line, mut word) = (0.0f64, 0.0f64);
    let mut inline_on_line = false; // content has landed on this line (a space after it is pending, not dropped)
    // A collapsible space waiting for content to follow it, and whether it JOINS the word rather than opening
    // a break — which is the mode of the run that QUEUED it (the oracle's `pend(w, joins)` / `pendingJoins`),
    // never the one that takes it. Live now that a non-wrapping run may sit in a wrapping box.
    let mut pending_space = 0.0f64;
    let mut pending_joins = false;
    macro_rules! opportunity {
        () => {{
            min = min.max(word);
            word = 0.0;
        }};
    }
    macro_rules! end_line {
        () => {{
            max = max.max(line);
            min = min.max(word);
            line = 0.0;
            word = 0.0;
            pending_space = 0.0;
            inline_on_line = false;
        }};
    }
    // A collapsible space after content: pending on the line, and a break opportunity unless the run never wraps
    // (then it joins the word when taken).
    macro_rules! pend {
        ($w:expr) => {{
            pending_space = $w;
            pending_joins = !wraps;
            if wraps {
                opportunity!();
            }
        }};
    }
    macro_rules! take_pending {
        () => {{
            line += pending_space;
            if pending_joins {
                word += pending_space;
            }
            pending_space = 0.0;
            pending_joins = false;
        }};
    }
    for (ri, run) in runs.iter().enumerate() {
        // …this run's own three behaviours, which the macros above close over.
        (wraps, preserve, break_nl) = modes(run.ws_mode)?;
        match run.kind {
            RUN_BR => end_line!(),
            RUN_WBR => opportunity!(),
            // An OUT-OF-FLOW box is not in the flow's inline stream: it contributes no advance to either
            // intrinsic width and brings no break opportunity — it is only a marker of where the flow reached,
            // and an intrinsic measure has no lines for that to mean anything on.
            RUN_OOF => {}
            RUN_OPEN => {
                // An inline's EDGES here are the BASIS-LESS ones (`Run::asc` on an edge run): an intrinsic measure
                // has no percentage basis, so a `padding: 0 10%` inline contributes nothing where the laid-out
                // line counts its resolved px.
                // The matching CLOSE (LIFO) — an inline with ANY horizontal edge takes the pending space at its open.
                let mut depth = 0i32;
                let mut close = None;
                for r in &runs[ri + 1..] {
                    match r.kind {
                        RUN_OPEN => depth += 1,
                        RUN_CLOSE if depth == 0 => {
                            close = Some(r.asc);
                            break;
                        }
                        RUN_CLOSE => depth -= 1,
                        _ => {}
                    }
                }
                if run.asc + close? != 0.0 {
                    take_pending!();
                }
                line += run.asc;
                word += run.asc;
            }
            RUN_CLOSE => {
                line += run.asc;
                word += run.asc;
            }
            RUN_TEXT => {
                let text = run_texts.get(ri).and_then(|t| t.as_ref())?;
                // Per-character breaking is the OWNER's mode (`minBreaksAnywhere`), never conditioned on what
                // the run holds — the oracle's `addUnit` reads it that way, and a single CJK character in a
                // paragraph must not stop its Latin words from breaking. Whether a WORD holds a wide character
                // is asked per word below, where `charUnits` asks it. ZWJ still declines under a per-character
                // mode: the oracle's advance there carries the previous character.
                let per_char = matches!(run.metric as u8, 1 | 3);
                if per_char && text.iter().any(|&u| u == 0x200D) {
                    return None;
                }
                let space_w = measure_word(run, &[0x20])?;
                // (`measure_word` only, so the tab pair it carries is never read — a word holds no tab.)
                let unspaced = Run { ls: 0.0, ws: 0.0, ..*run };
                let run_has_wide = text.iter().any(|&u| is_wide_unit(u)); // once per run, as in the flow arm
                let run_has_hyphen = text.iter().any(|&u| is_hyphen_unit(u));
                let mut i = 0;
                while i < text.len() {
                    if is_ws_u16(text[i]) {
                        let start = i;
                        let mut nl = 0u32;
                        while i < text.len() && is_ws_u16(text[i]) {
                            if text[i] == 0x0A {
                                nl += 1;
                            } else if text[i] != 0x20 && text[i] != 0x09 {
                                return None; // \r / \f — not modelled
                            }
                            i += 1;
                        }
                        if preserve {
                            // Every space is content on the line (an opportunity, when the mode wraps, before it
                            // — the oracle's order), and each newline ends the line where it sits. The spaces of
                            // each NEWLINE-SEGMENT are a placement of their own: they take the collapsed space
                            // waiting from an earlier run and they put content on the line (the oracle's
                            // `takePending(); inlineOnLine = true`, which it does per segment). Per segment and
                            // not once per run, so a segment the newline before it emptied starts over — and a
                            // run that OPENS with a newline drops the pending space with the line it ends.
                            let mut seg_open = false;
                            for &u in &text[start..i] {
                                if u == 0x0A {
                                    end_line!();
                                    seg_open = false;
                                } else {
                                    if !seg_open {
                                        take_pending!();
                                        inline_on_line = true;
                                        seg_open = true;
                                    }
                                    // A TAB's advance is the gap to the next stop from the pen, which here is
                                    // `line` — the oracle passes exactly that as `measureRun`'s `from` in its
                                    // own intrinsic arm. (It measures the whole whitespace TOKEN at once and
                                    // takes one opportunity for it; per character is the same arithmetic and
                                    // the same opportunities, since closing an empty word is a no-op.)
                                    let adv = if u == 0x09 { measure_at(run, &[u], line)? } else { space_w };
                                    if wraps {
                                        opportunity!();
                                    } else {
                                        word += adv;
                                    }
                                    line += adv;
                                }
                            }
                        } else if break_nl && nl > 0 {
                            for _ in 0..nl {
                                end_line!(); // pre-line: a newline is a line end, the spaces around it collapse away
                            }
                        } else if inline_on_line {
                            // A collapsed space: pending after content on the line, nothing at line start (an
                            // opportunity either way when the mode wraps — a no-op at line start, the word is empty).
                            pend!(space_w);
                        } else if wraps {
                            opportunity!();
                        }
                    } else {
                        let start = i;
                        while i < text.len() && !is_ws_u16(text[i]) {
                            i += 1;
                        }
                        // A word takes the pending space ONCE — the one before it in this run, or an earlier run's
                        // trailing space (a word glued to the previous run, nothing pending, continues that word).
                        take_pending!();
                        let word_wide = run_has_wide && text[start..i].iter().any(|&u| is_wide_unit(u));
                        // A HYPHEN is an opportunity here too, or min-content would be the whole hyphenated word
                        // where the flow can break it (`well-known` measures `known`, not both halves glued) —
                        // and it is the ONLY one the word then has: the oracle's `addUnit` returns on its hyphen
                        // branch, so a piece is measured whole however the mode would cut it in the flow. (Which
                        // is right for `overflow-wrap: break-word`, whose in-word breaks min-content ignores
                        // anyway, and is what parity asks of the other two.)
                        let word_hyphen = run_has_hyphen
                            && text[start..i].iter().any(|&u| is_hyphen_unit(u))
                            && (start..i).any(|k| hyphen_breaks_after(text, k, i));
                        if word_hyphen {
                            let mut u = start;
                            while u < i {
                                let pend = hyphen_piece_end(text, u, i);
                                let adv = measure_word(run, &text[u..pend])?;
                                line += adv;
                                word += adv;
                                if pend < i {
                                    opportunity!();
                                }
                                u = pend;
                            }
                        } else if per_char || word_wide {
                            let mut u = start;
                            while u < i {
                                // `own = perChar || isWideChar(cp)` — the oracle's `addUnit`, and BOTH halves of
                                // it matter. Under a per-character mode every code point is a unit, a wide-bearing
                                // word included (grouping its Latin tail back into one measured 58.63 where the
                                // oracle and Chrome say 50); otherwise only the WIDE units are opportunities, and
                                // the maximal Latin run between them is glued to whatever precedes it. Bracketing
                                // every unit instead closed the word at the Latin run's own edges, losing whatever
                                // was glued across a run boundary — `abcdef<b>gh日</b>` measured 42.63 against the
                                // oracle's 59.53, and a padded inline lost its 20px edge outright.
                                let ulen = break_unit_len(text, u, i, per_char);
                                let own = per_char || is_wide_unit(text[u]);
                                let adv = measure_word(&unspaced, &text[u..u + ulen])?;
                                if own {
                                    opportunity!();
                                }
                                line += adv;
                                word += adv;
                                if own {
                                    opportunity!();
                                }
                                u += ulen;
                            }
                        } else {
                            let w = measure_word(run, &text[start..i])?;
                            line += w;
                            word += w;
                        }
                        inline_on_line = true;
                    }
                }
            }
            RUN_ATOMIC if run.font >= 0 => {
                // A natively laid-out atomic: one unbreakable unit the line may break on either side of, its
                // own intrinsic widths plus its margins (the oracle's atomic arm).
                let c = run.font as usize;
                let k = inputs[c].get();
                let (imin, imax) = intrinsic_widths(c, inputs, all_runs, all_texts, grids, children)?;
                let m = k.decl_margin_x;
                take_pending!();
                opportunity!();
                line += imax + m;
                min = min.max(imin + m);
                inline_on_line = true;
                opportunity!();
            }
            _ => return None, // a PUSHED atomic — its intrinsic box is not in the stream
        }
    }
    max = max.max(line); // the last line closes without a reset
    min = min.max(word);
    if pin {
        min = max;
    }
    // KNOWN GAP (both engines, measured): a box can come back wanting MORE at min-content than at max — a SOFT
    // HYPHEN puts its width in `min` alone (`aaaa&shy;` is 33.73/28.41 here, 33.73/33.73 in Chrome, which
    // closes the gap by raising the max). Left alone deliberately: the rule that reproduces every figure is
    // Chrome's real break pass at zero available width, not a clamp on these two numbers.
    Some((min.max(0.0), max.max(0.0)))
}

// A GRID container (§12, see DISPLAY_GRID). Sizes the columns natively — measuring each item's min/max-content
// itself when a track asks for content (`intrinsic_widths`) — then runs the oracle's row-major placement: each
// in-flow item is laid out at its track width (auto fills the track less its margins; a length uses its
// resolved box); rows are as tall as their content (the tallest item's border box — a top margin moves the item
// but, matching the coarse oracle, neither grows the row nor stretches a shorter item) or, under
// `grid-auto-rows`, the declared height whatever the content (the container still reaches under an overflowing
// item). Bare text directly in the grid is an anonymous item the oracle never places — it only floors the auto
// height at its line-height (`anon_cross`). An out-of-flow child joins no row: its subtree lays out at its
// pushed box and `place` positions it by its displacement. The buffer at `grids[grid_start..]` is
// `[col_count, col_gap px, col_gap fraction, row_gap px, row_gap fraction, decl_row_h (NaN = content rows),
// template (GRID_TRACK_STRIDE per column), (col_start | -1, span) per in-flow item]`.
fn measure_grid(
    i: usize,
    w: f64,
    imposed_h: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> MInfo {
    let n = inputs[i].get().with_imposed_height(imposed_h);
    let bail = |failed: &std::cell::Cell<bool>| {
        failed.set(true);
        MInfo { top: CMargin::of(0.0), top_only: CMargin::of(0.0), bottom: CMargin::of(0.0), collapse_through: false }
    };
    let content_w = n.content_w(w);
    let content_top_rel = n.bt + n.pt;
    let content_left = n.bl + n.pl;
    let gs = n.grid_start.max(0) as usize;
    if gs + GRID_HEADER > grids.len() {
        return bail(failed);
    }
    let col_count = grids[gs] as usize;
    // The gaps arrive as `px + fraction` of the content box along their axis (`gapSpec`): a row gap's fraction
    // resolves against the content height where that is DEFINITE — declared or imposed — and is nothing where the
    // height is the rows' own, as the oracle's `layoutGrid` has it.
    let col_gap = grids[gs + 1] + grids[gs + 2] * content_w;
    let row_gap = grids[gs + 3] + if grids[gs + 4] != 0.0 { n.definite_content_h().map_or(0.0, |h| grids[gs + 4] * h) } else { 0.0 };
    let decl_row_h = grids[gs + 5];
    let tmpl_base = gs + GRID_HEADER;
    // The in-flow items, in record order — the out-of-flow children join no row.
    let kids: Vec<usize> = children[i].iter().copied().filter(|&c| inputs[c].get().out_of_flow == 0).collect();
    // Template is GRID_TRACK_STRIDE values per column; placement is 2 per in-flow item.
    if col_count == 0 || tmpl_base + GRID_TRACK_STRIDE * col_count + 2 * kids.len() > grids.len() {
        return bail(failed);
    }
    let tracks: Vec<GridTrack> = (0..col_count).map(|c| GridTrack::decode(grids, tmpl_base + GRID_TRACK_STRIDE * c)).collect();
    let place_base = tmpl_base + GRID_TRACK_STRIDE * col_count;
    let cells = grid_placement(grids, place_base, col_count, kids.len());
    for &c in &children[i] {
        let cn = inputs[c].get();
        if cn.out_of_flow != 0 {
            if cn.native_oof() {
                // §4.1: its static position is the grid's content origin (the content's right edge where the
                // inline axis runs from there), whatever precedes it; sized and placed by place_out_of_flow.
                boxes[c].x = if n.from_right() { content_left + content_w } else { content_left };
                boxes[c].y = content_top_rel;
                continue;
            }
            // Replayed: lay the subtree out at its pushed border box; `place` positions it by rel_x/rel_y alone.
            let cw = resolve_width(&cn, content_w);
            measure(c, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            boxes[c].x = 0.0;
            boxes[c].y = 0.0;
        }
    }
    // An intrinsic track (auto / min|max-content / fit-content / a minmax side) sizes from the items' content —
    // measured natively here; a template of px / % / fr sides needs no measure at all.
    let cols = if tracks.iter().any(GridTrack::needs_content) {
        match grid_column_content(&kids, &cells, col_count, inputs, runs, run_texts, grids, children) {
            Some(cols) => Some(cols),
            None => return bail(failed),
        }
    } else {
        None
    };
    let widths = grid_column_widths(&tracks, cols.as_deref(), content_w, col_gap);
    let mut offsets = vec![0.0f64; col_count];
    let mut atx = 0.0;
    for c in 0..col_count {
        offsets[c] = atx;
        atx += widths[c] + col_gap;
    }

    // Rows advance by the tallest item placed (content rows), or by the declared row height.
    let mut row_top = 0.0f64; // relative to the content origin
    let mut row_h = 0.0f64;
    let mut bottom = 0.0f64;
    for (k, &c) in kids.iter().enumerate() {
        let cell = cells[k];
        if k > 0 && cell.row != cells[k - 1].row {
            row_top += if is_auto(decl_row_h) { row_h } else { decl_row_h } + row_gap;
            row_h = 0.0;
        }
        let mut track_w = 0.0;
        for x in cell.col..cell.col + cell.span {
            track_w += widths[x] + if x > cell.col { col_gap } else { 0.0 };
        }
        let item = &inputs[c].get();
        let child_w = resolve_width(item, track_w);
        measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        let ih = boxes[c].h;
        boxes[c].x = content_left + offsets[cell.col] + Input::m(item.ml);
        boxes[c].y = content_top_rel + row_top + Input::m(item.mt);
        if ih > row_h {
            row_h = ih;
        }
        if row_top + ih > bottom {
            bottom = row_top + ih;
        }
    }

    let (fb, lb, ib) = child_baselines(children[i].iter().copied(), inputs, boxes);
    boxes[i].first_baseline = fb;
    boxes[i].last_baseline = lb;
    boxes[i].inline_block_baseline = ib;
    boxes[i].nid = n.nid;
    boxes[i].w = w;
    let box_h = if is_auto(n.height) {
        content_top_rel + bottom.max(n.anon_cross) + n.pb + n.bb
    } else if n.border_box {
        n.height.max(n.edges_y())
    } else {
        n.height + n.edges_y()
    };
    let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_y() };
    boxes[i].h = clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0);
    boxes[i].auto_height = is_auto(n.height);
    // A grid establishes an independent formatting context: its margins do not collapse with its items'.
    let top = CMargin::of(Input::m(n.mt));
    MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false }
}

// A container's first / last baseline from its children in the given order — the first that has a first
// baseline and the last that has a last baseline, each offset by the child's relative top; out-of-flow and
// floated children give none (the oracle's `baselineCandidates`).
fn child_baselines(order: impl Iterator<Item = usize> + Clone, inputs: &[Cell<Input>], boxes: &[Box]) -> (Option<f64>, Option<f64>, Option<f64>) {
    let mut first = None;
    let mut last = None;
    let mut inline_block = None;
    for c in order {
        let cn = inputs[c].get();
        if cn.out_of_flow != 0 || cn.float_kind != 0 {
            continue;
        }
        if first.is_none() {
            if let Some(b) = boxes[c].first_baseline {
                first = Some(boxes[c].y + b);
            }
        }
        if let Some(b) = boxes[c].last_baseline {
            last = Some(boxes[c].y + b);
        }
        // A scroll container gives its bottom margin edge — except a BUTTON, which is a button however it
        // scrolls (the oracle's exception; a control atomic reaches native now, so this is live rather than
        // pushed, but the rule has to be the same rule).
        if cn.scrolls_y && !cn.is_button {
            inline_block = Some(boxes[c].y + boxes[c].h + Input::m(cn.mb));
        } else if let Some(b) = boxes[c].inline_block_baseline {
            inline_block = Some(boxes[c].y + b);
        }
    }
    (first, last, inline_block)
}

// A REPLACED box's used border-box (width, height) — the oracle's `usedSize` for a box with an intrinsic size:
// the declared width / height win (content-box unless `box-sizing: border-box`), else the intrinsic size plus the
// edges (a ratio-only box with no declared width takes `auto_w`, the room on offer); an intrinsic RATIO derives
// the other axis from a declared one (or from the room, for a ratio-only box); min/max clamp through the ratio
// (`clampWithRatio`: the binding clamp scales the content box, the other axis follows) or plainly without one; a
// border box is floored at its own edges. Never auto-height: a replaced box is definite.
fn replaced_box(n: &Input, auto_w: f64) -> (f64, f64) {
    let (extra_w, extra_h) = (n.edges_x(), n.edges_y());
    let (w_decl, h_decl) = (!is_auto(n.width), !is_auto(n.height));
    let grow = (w_decl || h_decl) && !n.border_box;
    let sized = !n.ratio_only;
    let mut width = if w_decl { n.width + if grow { extra_w } else { 0.0 } } else if sized { n.intrinsic_w + extra_w } else { auto_w };
    let mut height = if h_decl { n.height + if grow { extra_h } else { 0.0 } } else if sized { n.intrinsic_h + extra_h } else { 0.0 };
    let ratio = if n.ratio && n.intrinsic_w > 0.0 && n.intrinsic_h > 0.0 { n.intrinsic_w / n.intrinsic_h } else { 0.0 };
    if ratio > 0.0 {
        if !h_decl && (w_decl || n.ratio_only) {
            height = (width - extra_w).max(0.0) / ratio + extra_h;
        } else if !w_decl && h_decl {
            width = (height - extra_h).max(0.0) * ratio + extra_w;
        }
    }
    let to_border_w = |v: f64| if is_auto(v) || n.border_box { v } else { v + extra_w };
    let to_border_h = |v: f64| if is_auto(v) || n.border_box { v } else { v + extra_h };
    let clamp_w = |bw: f64| clamp_min_max(bw, to_border_w(n.min_w), to_border_w(n.max_w));
    let clamp_h = |bh: f64| clamp_min_max(bh, to_border_h(n.min_h), to_border_h(n.max_h));
    if ratio > 0.0 {
        // CSS 2.1 §10.4's constraint table for a box whose axes are tied by a ratio: whichever clamp binds hardest
        // wins, the other axis follows the ratio and is clamped in turn; only an AUTO axis follows.
        let (cw, ch) = ((width - extra_w).max(0.0), (height - extra_h).max(0.0));
        let sw = if cw > 0.0 { (clamp_w(width) - extra_w) / cw } else { 1.0 };
        let sh = if ch > 0.0 { (clamp_h(height) - extra_h) / ch } else { 1.0 };
        let (auto_w_axis, auto_h_axis) = (!w_decl, !h_decl);
        let scale = if auto_w_axis && auto_h_axis {
            if sw == 1.0 { sh } else if sh == 1.0 { sw } else if (sw < 1.0) != (sh < 1.0) { 0.0 } else if sw < 1.0 { sw.min(sh) } else { sw.max(sh) }
        } else if auto_h_axis {
            sw
        } else if auto_w_axis {
            sh
        } else {
            0.0
        };
        if scale == 0.0 || scale == 1.0 {
            width = clamp_w(width);
            height = clamp_h(height);
        } else {
            width = clamp_w(cw * scale + extra_w);
            height = clamp_h(ch * scale + extra_h);
        }
    } else {
        width = clamp_w(width);
        height = clamp_h(height);
    }
    if n.border_box {
        width = width.max(extra_w);
        height = height.max(extra_h);
    }
    (width, height)
}

// Convert the relative boxes to absolute document coordinates: add each node's absolute border-box
// origin to its children (whose x/y are relative to it), top-down in one pass — plus each node's
// `position: relative` offset, which moves it AND its subtree at paint time (the flow used the unshifted
// position, so only this pass, after the origin is added, applies the shift; children follow via `bx`/`by`).
fn place(
    i: usize,
    ax: f64,
    ay: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) {
    boxes[i].x += ax + inputs[i].get().rel_x;
    boxes[i].y += ay + inputs[i].get().rel_y;
    let (bx, by) = (boxes[i].x, boxes[i].y);
    for &c in &children[i] {
        if inputs[c].get().native_oof() {
            place_out_of_flow(c, i, inputs, runs, run_texts, grids, children, boxes, failed);
        } else {
            place(c, bx, by, inputs, runs, run_texts, grids, children, boxes, failed);
        }
    }
}

// Where an in-flow BLOCK-LEVEL child sits across its band, CSS 2.1 §10.3.3 applied: the leftover width goes to
// whichever horizontal margins are `auto` — both, and the box is centred; one, and it is pushed to the other
// side — and HTML's legacy `<center>` / `align` moves a box with no auto margin the same way. The flow's own
// direction decides which margin LEADS: an `rtl` containing block balances on `margin-left`, so a 500px block
// with `margin: 0 auto` in a 400px rtl container hangs off the LEFT. A FLOAT never distributes (§10.3.5
// computes its auto margins to zero); it is placed by the float machinery, and the guard here says so anyway.
// (Only the LEADING margin is returned: the trailing one is what the oracle stamps as `_lbMargins`, which is
// what `getComputedStyle().marginLeft` resolves to on a centred box. Native produces no such output yet — one
// of the oracle outputs still to be carried across before the JS layout can go.)
fn block_child_x(n: &Input, cn: &Input, band_l: f64, band_r: f64, w: f64) -> f64 {
    let (ml, mr) = (Input::m(cn.ml), Input::m(cn.mr));
    let from_right = n.from_right();
    let (lm, tm) = if from_right { (mr, ml) } else { (ml, mr) };
    let (lead_auto, trail_auto) = if from_right {
        (cn.auto_margins & 2 != 0, cn.auto_margins & 1 != 0)
    } else {
        (cn.auto_margins & 1 != 0, cn.auto_margins & 2 != 0)
    };
    let distributes = cn.auto_margins & 3 != 0 && cn.float_kind == 0;
    let lead = if distributes {
        auto_margin_split(lead_auto, trail_auto, lm, tm, band_r - band_l, w).0
    } else {
        lm + legacy_align_shift(n.legacy_align, from_right, band_r - band_l - w - ml - mr)
    };
    if from_right { band_r - w - lead } else { band_l + lead }
}

// …the legacy half of it, as an offset ON the leading margin: `<center>` centres, `align=right` pushes to the
// end, `align=left` to the start — each measured from the edge the flow starts at, so an rtl block moves the
// other way. Only a POSITIVE leftover moves anything.
fn legacy_align_shift(legacy_align: u8, from_right: bool, spare: f64) -> f64 {
    if legacy_align == 0 || !(spare > 0.0) {
        return 0.0;
    }
    match (legacy_align, from_right) {
        (1, false) | (1, true) => spare / 2.0, // center, either way round
        (2, false) => spare,                   // right, in an ltr flow: all the way to the end
        (2, true) => 0.0,                      // …which in rtl is where the box already starts
        (3, false) => 0.0,                     // left, in ltr: likewise already there
        (3, true) => spare,
        _ => 0.0,
    }
}

// The slack between two insets shared out to `auto` margins (CSS 2.1 §10.3.7 across, §10.6.4 down) — the
// oracle's `autoMarginSplit`: both auto centre the box, one auto takes it all, and an over-constrained box (no
// slack) sits flush at the lead edge with the trailing margin absorbing the negative remainder.
fn auto_margin_split(lead_auto: bool, trail_auto: bool, lm: f64, tm: f64, available: f64, size: f64) -> (f64, f64) {
    if !lead_auto && !trail_auto {
        return (lm, tm);
    }
    let spare = available - size - if lead_auto { 0.0 } else { lm } - if trail_auto { 0.0 } else { tm };
    if !(spare > 0.0) {
        return (if lead_auto { 0.0 } else { lm }, if trail_auto { spare } else { tm });
    }
    if lead_auto && trail_auto {
        return (spare / 2.0, spare / 2.0);
    }
    if lead_auto { (spare, tm) } else { (lm, spare) }
}

// Where `justify-content` puts the SOLE flex item of a line — an out-of-flow child's static position (§4.1, the
// oracle's `justifyOffsets` with `staticPos`): a distribution keyword falls back to its alignment even when the
// box overflows (`space-around` / `space-evenly` centre it, `space-between` packs at the start).
fn static_justify_lead(code: u8, free: f64) -> f64 {
    match code {
        1 | 4 | 5 => free / 2.0, // center, space-around, space-evenly (one item)
        2 => free,               // end
        _ => 0.0,                // start, space-between
    }
}

// Size and place an OUT-OF-FLOW box (§10.3.7 / §10.6.4 — the oracle's `placeAbsolute`) from its containing
// block, now that every box is final: the CB's padding box in absolute coordinates gives the insets their basis;
// both insets on an axis STRETCH an auto size between them (less the box's margins, an `auto` margin taking the
// slack), one or none leaves an auto width to SHRINK TO FIT (its intrinsic widths clamped to the room; a
// ratio-only box takes the room) and an auto height to its content; a declared size wins either way (a replaced
// box through its intrinsic size). The subtree is laid out at that size here — it needed the CB's height, which
// only the finished layout has — and the box is placed from its insets, or from its STATIC position where an axis
// has none: the flow cursor its parent recorded (`boxes[c]` before this call, relative to the parent; an rtl
// flow's static corner is the content's right edge), or a flex container's ALIGNMENT of the box as its sole item.
fn place_out_of_flow(
    c: usize,
    parent: usize,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) {
    // The containing block's PADDING box, in document coordinates: from its record where the pass holds one
    // (its border box less its borders, final by the time `place` reaches here), else the rectangle the walk
    // pushed for a CB outside the pass (the viewport, an ancestor above the root, an inline box).
    let declared = inputs[c].get();
    let (cb_x, cb_y, cb_w, cb_h) = if declared.cb_index == CB_RECT {
        (declared.cb_rect[0], declared.cb_rect[1], declared.cb_rect[2], declared.cb_rect[3])
    } else {
        let cb_i = declared.cb_index as usize;
        let cbn = inputs[cb_i].get();
        (
            boxes[cb_i].x + cbn.bl,
            boxes[cb_i].y + cbn.bt,
            (boxes[cb_i].w - cbn.bl - cbn.br).max(0.0),
            (boxes[cb_i].h - cbn.bt - cbn.bb).max(0.0),
        )
    };
    // …which is what this box's percentages resolve against — its sizes and edges (`with_percent_sizes`) and its
    // insets — written back before it is measured.
    let n = declared.with_percent_sizes(cb_w, cb_h);
    inputs[c].set(n);
    let [ft, fr, fb, fl] = n.inset_frac;
    let (top, right, bottom, left) = (n.inset_top + ft * cb_h, n.inset_right + fr * cb_w, n.inset_bottom + fb * cb_h, n.inset_left + fl * cb_w);
    let (ml, mr, mt, mb) = (Input::m(n.ml), Input::m(n.mr), Input::m(n.mt), Input::m(n.mb));
    let stretched = !is_auto(left) && !is_auto(right);
    let stretched_v = !is_auto(top) && !is_auto(bottom);
    let or0 = |v: f64| if is_auto(v) { 0.0 } else { v };
    let avail_w = (cb_w - or0(left) - or0(right)).max(0.0);
    let avail_h = if stretched_v { (cb_h - top - bottom).max(0.0) } else { 0.0 };
    // The static position its parent recorded (relative to the parent's border box), read before the box is sized.
    let (static_rx, static_ry) = (boxes[c].x, boxes[c].y);
    let auto_w = if stretched || (n.replaced && n.ratio_only) {
        (avail_w - ml - mr).max(0.0)
    } else if !is_auto(n.width) {
        // A DECLARED width: `used_width` answers from the declaration and discards `auto_w`, so the
        // shrink-to-fit measure is not merely wasted work (an O(subtree) walk per out-of-flow box) — asked, it
        // descends where the WALK did not gate for it. The record's `decl_w` is basis-less, so a PERCENTAGE
        // width reads as `auto` inside `intrinsic_widths` and the walk it short-circuits for a length runs
        // after all: a `position: absolute; width: 50%` box holding an atomic native cannot measure failed the
        // whole pass over a figure nobody reads.
        0.0
    } else {
        match shrink_to_fit_width(c, avail_w, inputs, runs, run_texts, grids, children) {
            Some(w) => w,
            None => {
                failed.set(true);
                0.0
            }
        }
    };
    let w = used_width(&n, auto_w);
    // A stretched AUTO height is imposed (usedSize hands it in as the box's height; the flow keeps a non-zero one) —
    // a zero one is the oracle's auto placeholder and back-fills from the content.
    let auto_h = if stretched_v { (avail_h - mt - mb).max(0.0) } else { 0.0 };
    let imposed = if is_auto(n.height) && auto_h > 0.0 { auto_h } else { f64::NAN };
    measure(c, w, imposed, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
    let h = boxes[c].h;
    let am = n.auto_margins;
    let (mx_lead, mx_trail) = if stretched { auto_margin_split(am & 1 != 0, am & 2 != 0, ml, mr, avail_w, w) } else { (ml, mr) };
    let (my_lead, my_trail) = if stretched_v { auto_margin_split(am & 4 != 0, am & 8 != 0, mt, mb, avail_h, h) } else { (mt, mb) };
    // The static position, in absolute coordinates: the parent's origin plus what it recorded — or, for a flex
    // container, the box aligned as the line's sole item (§4.1: justify-content along the main axis, its own
    // align-self across, its MARGIN box being what is aligned).
    let pn = inputs[parent].get();
    let (px, py) = (boxes[parent].x, boxes[parent].y);
    let (static_x, static_y) = if pn.display == DISPLAY_FLEX {
        let (ix, iy) = (px + pn.bl + pn.pl, py + pn.bt + pn.pt);
        let inner_w = pn.content_w(boxes[parent].w);
        let inner_h = (boxes[parent].h - pn.edges_y()).max(0.0);
        let (main_size, cross_size) = if pn.flex_main_is_x { (inner_w, inner_h) } else { (inner_h, inner_w) };
        let main_box = if pn.flex_main_is_x { w } else { h };
        // The leading main margin is the one on the main-START side (the far physical side on a reversed axis).
        let (main_lead, main_item) = if pn.flex_main_is_x {
            (if pn.flex_main_reverse { mr } else { ml }, w + ml + mr)
        } else {
            (if pn.flex_main_reverse { mb } else { mt }, h + mt + mb)
        };
        // A cross axis that runs from the far physical edge back — an rtl COLUMN, a `*-rl` ROW, anything
        // under `wrap-reverse` — puts its cross-start at the far edge: the leading cross margin is the one on
        // that side and the cross offset is measured back from it (the oracle's `alongAxis`).
        let cross_far = pn.flex_cross_far;
        let (cross_lead, cross_item) = if pn.flex_main_is_x {
            (if cross_far { mb } else { mt }, h + mt + mb)
        } else {
            (if cross_far { mr } else { ml }, w + ml + mr)
        };
        let main = static_justify_lead(pn.flex_justify, main_size - main_item) + main_lead;
        let cross_free = cross_size - cross_item;
        let cross = match n.flex_cross_align {
            1 => cross_free / 2.0,
            2 => cross_free,
            _ => 0.0,
        } + cross_lead;
        let along = |reversed: bool, size: f64, from_start: f64, item: f64| if reversed { size - from_start - item } else { from_start };
        if pn.flex_main_is_x {
            (ix + along(pn.flex_main_reverse, inner_w, main, main_box), iy + along(cross_far, inner_h, cross, h))
        } else {
            (ix + along(cross_far, inner_w, cross, w), iy + along(pn.flex_main_reverse, inner_h, main, main_box))
        }
    } else if pn.from_right() {
        // …and an inline axis running from the RIGHT puts the static corner at the content's right edge, less
        // the box (`staticCornerFor`, which asks for that physical side — a vertical mode's rtl has none).
        (px + static_rx - w, py + static_ry)
    } else {
        (px + static_rx, py + static_ry)
    };
    let x = if !is_auto(left) {
        cb_x + left + mx_lead
    } else if !is_auto(right) {
        cb_x + cb_w - right - w - mx_trail
    } else {
        static_x
    };
    let y = if !is_auto(top) {
        cb_y + top + my_lead
    } else if !is_auto(bottom) {
        cb_y + cb_h - bottom - h - my_trail
    } else {
        static_y
    };
    boxes[c].x = x;
    boxes[c].y = y;
    for &cc in &children[c] {
        if inputs[cc].get().native_oof() {
            place_out_of_flow(cc, c, inputs, runs, run_texts, grids, children, boxes, failed);
        } else {
            place(cc, x, y, inputs, runs, run_texts, grids, children, boxes, failed);
        }
    }
}

// Resolve a block's BORDER-BOX width against containing-block content width `cb_w`. auto → fill the CB
// (minus this box's own horizontal margins); a declared width is content-box unless box-sizing:border-box,
// then converted to border-box; clamped by min/max (which are treated in the same box model).
fn resolve_width(n: &Input, cb_w: f64) -> f64 {
    // auto: fill the containing block, less horizontal margins (auto margins count 0 in L1).
    used_width(n, (cb_w - Input::m(n.ml) - Input::m(n.mr)).max(0.0))
}
// How far right a box's IN-FLOW content reaches, off its own border-box origin, recursively — never short of the
// box itself (the oracle's `_lbFlowRight`, which `stampExtent` unions the same way). An out-of-flow box is not
// part of what its parent wraps, and neither is anything inside it. A relative shift is: the oracle folds it into
// the box before the extent is stamped.
fn flow_right(c: usize, inputs: &[Cell<Input>], children: &[Vec<usize>], boxes: &[Box]) -> f64 {
    let mut reach = boxes[c].w;
    for &k in &children[c] {
        if inputs[k].get().out_of_flow != 0 {
            continue;
        }
        reach = reach.max(boxes[k].x + inputs[k].get().rel_x + flow_right(k, inputs, children, boxes));
    }
    reach
}
// What an AUTO width becomes for a box sized from its own CONTENT in `room` of inline space — the oracle's
// `shrinkToFitWidth`: its min-content, widened to the room, capped at its max-content. Both figures carry the
// percentage part of the box's own edges, which an intrinsic CONTRIBUTION reads as nothing and a USED size
// puts back (`pct_edges_x`). `None` where native cannot measure the subtree; each caller decides what that
// means (a whole-pass failure, or `?` out of its own sizing). What `room` is differs by caller — the callers
// mirror the basis their oracle counterpart passes.
fn shrink_to_fit_width(
    c: usize,
    room: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<f64> {
    let (imin, imax) = intrinsic_widths(c, inputs, runs, run_texts, grids, children)?;
    let pct = inputs[c].get().pct_edges_x();
    Some((imin + pct).max(room).min(imax + pct))
}
// The BORDER-BOX width an in-flow BLOCK-LEVEL child uses, given the inline room its containing block leaves it
// (`avail` — the content width, or the band a float narrows it to). Normally that is the containing block's
// room (`resolve_width`); a box whose own block axis is the HORIZONTAL one (a vertical `writing-mode`) has no
// inline size to fill there, so its auto width comes from its own content instead. The walk both refuses such
// a child native cannot measure and walks the rest MEASURED (`nlIntrinsicMeasurable` + `walkMeasured`), so
// `None` here means that gate has a hole — fail the pass rather than answer with a width nothing measured.
#[allow(clippy::too_many_arguments)]
fn block_child_width(
    c: usize,
    avail: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    failed: &std::cell::Cell<bool>,
) -> f64 {
    let cn = &inputs[c].get();
    // A box sized from its OWN CONTENT here rather than from the room on offer: an intrinsic-size KEYWORD, a
    // vertical writing mode's auto width — and a `<button>`, which is as wide as its content wants whatever
    // display it has and however much room it is given (HTML's button layout IS the shrink-to-fit algorithm;
    // the oracle's `shrinkWrapsToFit`). A block-level one filled its container here, which is 900px of
    // clickable target where Chrome draws 132.
    let content_sized = cn.width_kw != 0 || (is_auto(cn.width) && (cn.block_axis_is_x || cn.is_button));
    if !content_sized {
        return resolve_width(cn, avail);
    }
    let room = (avail - Input::m(cn.ml) - Input::m(cn.mr)).max(0.0);
    match content_sized_width(c, room, inputs, runs, run_texts, grids, children) {
        Some(w) => used_width(cn, w),
        None => {
            failed.set(true);
            0.0
        }
    }
}
// What a box sized from its OWN CONTENT comes to in `room` of inline space (the oracle's `usedSize` for the
// same box): an intrinsic-size KEYWORD asks for its min-content, its max-content, or — `fit-content` — the
// room clamped between the two; no keyword is the shrink-to-fit rule, which is `fit-content` by another name
// and what a float's `auto` width means (§10.3.5), and a vertical writing mode's auto width again. Each
// figure carries the percentage part of the box's own edges back (`pct_edges_x`, which an intrinsic
// CONTRIBUTION leaves out). `None` where native cannot measure the subtree — the caller decides.
#[allow(clippy::too_many_arguments)]
fn content_sized_width(
    c: usize,
    room: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<f64> {
    let cn = &inputs[c].get();
    match cn.width_kw {
        0 => shrink_to_fit_width(c, room, inputs, runs, run_texts, grids, children),
        kw => intrinsic_widths(c, inputs, runs, run_texts, grids, children).map(|(imin, imax)| {
            let pct = cn.pct_edges_x();
            match kw {
                1 => imin + pct,
                2 => imax + pct,
                // …min-content winning where the two figures cross (a negative margin can take max-content under
                // the widest piece), as the oracle's `Math.max(min, Math.min(max, …))` has it.
                _ => (room - pct).min(imax).max(imin) + pct,
            }
        }),
    }
}
// The BORDER-BOX width a box uses given what an AUTO width would be (`auto_w` — the oracle's `usedSize` with
// its `autoW`: the containing block's room in block flow, or a content size where the box is sized from its own
// content there — a vertical writing mode, a flex column item, an out-of-flow or atomic box —
// `shrink_to_fit_width`): a declared width converted to border-box, else `auto_w`, clamped by min/max-width
// (same box model).
fn used_width(n: &Input, auto_w: f64) -> f64 {
    if n.replaced {
        return replaced_box(n, auto_w).0;
    }
    let border_w = if is_auto(n.width) {
        auto_w
    } else if n.border_box {
        n.width
    } else {
        n.width + n.edges_x()
    };
    // min/max-width are content-box in CSS unless border-box; convert to border-box for the clamp.
    let to_border = |v: f64| if is_auto(v) || n.border_box { v } else { v + n.edges_x() };
    let w = clamp_min_max(border_w, to_border(n.min_w), to_border(n.max_w));
    // A BORDER box is never smaller than the border and padding inside it — the content box floors at zero, it
    // does not go negative. The floor comes LAST, AFTER the clamp, exactly as `usedSize` applies it: a
    // `max-width` below the box's own edges clamps the width under them and the floor lifts it back
    // (`box-sizing: border-box; padding: 0 10px; max-width: 5px` is 20 wide in Chrome, not 5). Floored first,
    // the max clamped it below its own padding again.
    if n.border_box { w.max(n.edges_x()) } else { w.max(0.0) }
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
            bottom_adjoins: true,
            run_start: -1,
            run_count: 0,
            strut_lh: 0.0,
            strut_asc: 0.0,
            float_kind: 0,
            clear: 0,
            takes_clearance: false,
            starts_bfc: false,
            flex_justify: 0,
            flex_main_gap: 0.0,
            flex_cross_align: 0,
            flex_main_is_x: true, // row by default
            flex_wrap: false,
            flex_cross_flip: false,
            flex_align_content: 6, // stretch
            flex_cross_gap: 0.0,
            flex_main_reverse: false,
            flex_cross_far: false,
            has_replayed_oof: false,
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
            text_align: 0,
            anon_cross: 0.0,
            ws_mode: 0,
            item_auto_height: false,
            pushed_h_indefinite: false,
            grid_start: -1,
            decl_w: f64::NAN,
            decl_min_w: f64::NAN,
            decl_max_w: f64::NAN,
            flex_basis: f64::NAN,
            flex_grow: 0.0,
            decl_border_box: false,
            flex_shrink: 1.0,
            flex_basis_cb: f64::NAN,
            flex_basis_frac: f64::NAN,
            pct_sizes: [f64::NAN; 6],
            edge_frac: [0.0; 8],
            edge_px: [0.0; 8],
            inset_frac: [0.0; 4],
            flex_main_gap_frac: 0.0,
            flex_cross_gap_frac: 0.0,
            flex_basis_kw: 0,
            scrolls_x: false,
            scrolls_y: false,
            is_button: false,
            self_sizes: false,
            block_axis_is_x: false,
            decl_edges_x: 0.0,
            decl_margin_x: 0.0,
            cell_pct: f64::NAN,
            cell_min_content: f64::NAN,
            cell_max_content: f64::NAN,
            height_is_floor: false,
            cell_valign: 0,
            row_height: f64::NAN,
            row_pct: f64::NAN,
            row_rank: 1,
            table_fixed: false,
            flex_stretch: false,
            flex_native: false,
            flex_dir_reverse: false,
            replaced: false,
            ratio: false,
            ratio_only: false,
            shrinks_to_nothing: false,
            control_baseline: 0,
            control_font_box: 0.0,
            control_font_asc: 0.0,
            intrinsic_w: 0.0,
            intrinsic_h: 0.0,
            cb_index: -1,
            cb_rect: [0.0, 0.0, 0.0, 0.0],
            inset_top: f64::NAN,
            inset_right: f64::NAN,
            inset_bottom: f64::NAN,
            inset_left: f64::NAN,
            auto_margins: 0,
            legacy_align: 0,
            indent_px: 0.0,
            indent_hanging: false,
            indent_each_line: false,
            indent_spent: false,
            width_kw: 0,
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1], Box { nid: 1.0, x: 0.0, y: 0.0, w: 800.0, h: 50.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None });
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 50.0, w: 800.0, h: 30.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None });
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 300.0));
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
        a.bottom_adjoins = false;
        let inputs = vec![blk(0.0, -1), a];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 100.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        a.bottom_adjoins = false;
        let mut b = blk(2.0, 0);
        b.height = 0.0;
        b.height_adjoins = true; // height:0 adjoins the THROUGH rule (auto or zero)
        b.bottom_adjoins = false; //  …but not the BOTTOM rule, which wants auto
        b.mt = 20.0;
        b.mb = 40.0;
        let mut c = blk(3.0, 0);
        c.height = 30.0;
        c.height_adjoins = false;
        c.bottom_adjoins = false;
        let inputs = vec![blk(0.0, -1), a, b, c];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        a.bottom_adjoins = false;
        a.mb = 10.0;
        let mut p = blk(2.0, 0); // auto height, no border/padding
        p.mt = 30.0;
        p.mb = 5.0;
        let empty = blk(3.0, 2); // P's only child, empty → collapses through
        let mut c = blk(4.0, 0);
        c.height = 30.0;
        c.height_adjoins = false;
        c.bottom_adjoins = false;
        c.mt = 20.0;
        let inputs = vec![blk(0.0, -1), a, p, empty, c];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        f.bottom_adjoins = false;
        let inputs = vec![blk(0.0, -1), owner, f];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].h, 120.0); // owner contains the float
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 0.0, w: 80.0, h: 120.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None });
    }

    #[test]
    fn two_left_floats_second_drops_when_it_does_not_fit() {
        // owner content width 200; two left floats 120 wide each — the second cannot sit beside the first
        // (240 > 200), so it drops below it (§9.5.1 rule 3).
        let mut owner = blk(1.0, 0);
        owner.starts_bfc = true;
        owner.width = 200.0;
        owner.height_adjoins = false;
        owner.bottom_adjoins = false;
        let mut a = blk(2.0, 1);
        a.float_kind = FLOAT_LEFT;
        a.width = 120.0;
        a.height = 40.0;
        a.height_adjoins = false;
        a.bottom_adjoins = false;
        let mut b = blk(3.0, 1);
        b.float_kind = FLOAT_LEFT;
        b.width = 120.0;
        b.height = 30.0;
        b.height_adjoins = false;
        b.bottom_adjoins = false;
        let inputs = vec![blk(0.0, -1), owner, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        c.bottom_adjoins = false;
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
            let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
            assert_eq!([bx[1].x, bx[2].x, bx[3].x], xs, "justify code {code}");
        }
    }

    #[test]
    fn flex_row_gap_and_margins() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_gap = 20.0;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 120.0, 240.0]); // 100 + 20 gap

        // A left margin on the middle item pushes it (and the run after) right.
        let mut m = item(2.0, 0, 100.0, 30.0);
        m.ml = 15.0;
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), m, item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 115.0, 215.0]);
    }

    #[test]
    fn flex_row_cross_align() {
        // 90px-tall row, a 30px item — align-items start / center / end.
        for (code, y) in [(0u8, 0.0), (1u8, 30.0), (2u8, 60.0)] {
            let mut f = flex(0.0, -1, 600.0);
            f.height = 90.0;
            f.height_adjoins = false;
            f.bottom_adjoins = false;
            let mut a = item(1.0, 0, 100.0, 30.0);
            a.flex_cross_align = code;
            let inputs = vec![f, a];
            let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let b = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        f.bottom_adjoins = false;
        let mut a = item(1.0, 0, 39.0, 37.0);
        a.flex_cross_align = CROSS_BASELINE_LAST;
        a.flex_baseline_asc = 29.0;
        let mut b = item(2.0, 0, 16.0, 18.0);
        b.flex_cross_align = CROSS_BASELINE_LAST;
        b.flex_baseline_asc = 14.0;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].y, bx[2].y], [43.0, 58.0]);
    }

    #[test]
    fn flex_row_first_and_last_baseline_groups_coexist() {
        // 80px row: a first-baseline item (asc 29) hangs at the cross-START (y=0); a last-baseline item (asc
        // 14, lastExtent 14+4=18) hangs at the cross-END (80-18=62, +14-14 → 62).
        let mut f = flex(0.0, -1, 400.0);
        f.height = 80.0;
        f.height_adjoins = false;
        f.bottom_adjoins = false;
        let mut a = item(1.0, 0, 39.0, 37.0);
        a.flex_cross_align = CROSS_BASELINE;
        a.flex_baseline_asc = 29.0;
        let mut b = item(2.0, 0, 16.0, 18.0);
        b.flex_cross_align = CROSS_BASELINE_LAST;
        b.flex_baseline_asc = 14.0;
        let inputs = vec![f, a, b];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
            f.bottom_adjoins = false;
            let mut a = item(1.0, 0, 100.0, 30.0);
            a.flex_item_auto = bits;
            let inputs = vec![f, a];
            let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 20.0);
        assert_eq!(bx[1].y, 0.0);
    }

    #[test]
    fn flex_column_stacks_items_and_auto_height_sums_them() {
        let inputs = vec![flex_col(0.0, -1, 200.0), item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0), item(3.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        f.bottom_adjoins = false;
        f.flex_justify = 1; // center
        let inputs = vec![f, item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0), item(3.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        // free = 200 - 90 = 110; center lead = 55 → y 55 / 85 / 115.
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [55.0, 85.0, 115.0]);
        assert_eq!(bx[0].h, 200.0);
    }

    #[test]
    fn flex_column_cross_align_center_on_x() {
        let mut a = item(1.0, 0, 50.0, 30.0);
        a.flex_cross_align = 1; // center on the cross (X) axis
        let inputs = vec![flex_col(0.0, -1, 200.0), a];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        f.bottom_adjoins = false;
        f.min_h = 90.0;
        f.flex_justify = 2; // end
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 90.0);
        assert_eq!(bx[1].y, 60.0); // extent 90, free 60, end
    }

    #[test]
    fn flex_row_reverse_places_from_the_right() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_reverse = true;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [500.0, 400.0, 300.0]); // first item rightmost, packed at the right
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [0.0, 0.0, 0.0]);       // cross still forward
    }

    #[test]
    fn flex_column_reverse_places_from_the_bottom() {
        let mut f = flex_col(0.0, -1, 200.0);
        f.flex_main_reverse = true;
        f.height = 200.0;
        f.height_adjoins = false;
        f.bottom_adjoins = false;
        let inputs = vec![f, item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        f.bottom_adjoins = false;
        f.flex_align_content = 1; // center
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[3].y, 40.0); // 30 (line 0) + 10 (cross gap)
        assert_eq!(bx[0].h, 70.0); // 30 + 10 + 30
    }

    #[test]
    fn flex_row_auto_height_wraps_the_tallest_item() {
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 50.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 50.0); // auto height = tallest item outer
        assert!(bx[0].auto_height);
    }

    #[test]
    fn unsupported_subtree_declines() {
        let mut a = blk(1.0, 0);
        a.display = DISPLAY_UNSUPPORTED; // e.g. flex
        let inputs = vec![blk(0.0, -1), a];
        assert!(matches!(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
    }

    fn tbl(nid: f64, parent: i32, sx: f64, sy: f64) -> Input {
        let mut c = blk(nid, parent);
        c.display = DISPLAY_TABLE;
        c.sp_x = sx;
        c.sp_y = sy;
        c.self_sizes = true; // an in-flow block-level table: its auto width shrink-to-fits its columns
        c.grid_start = -1;   // no column side-channel: the cells' reach is the column count
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
    // A cell that DECLARES its width (so its column sizes to `w` — `intrinsic_widths` pins min == max there)
    // and its height (a FLOOR for a cell, so with no content it is what the row comes to).
    fn cell(nid: f64, parent: i32, w: f64, h: f64, col: usize, colspan: usize, rowspan: usize) -> Input {
        let mut c = item(nid, parent, w, h);
        c.decl_w = w;
        c.decl_border_box = true;
        c.height_is_floor = true;
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [106.0, 66.0]); // Σtracks (102 / 62) + the table's own edges (2 each side)
        assert_eq!([bx[3].x, bx[3].y], [2.0, 2.0]); // content origin = the table border (no padding, no spacing)
        assert_eq!(bx[4].x, 48.0); // 2 + 46 (cells meet, no spacing)
        assert_eq!(bx[6].y, 28.0); // 2 + 26
    }

    #[test]
    fn table_spanning_cells_top_up_the_columns_they_cover() {
        // col 1 is covered only by spans (row0 cols 0-1, row1 cols 1-2): no colspan==1 cell sizes it, so it gets
        // only what the spans are short of, shared in proportion to what the covered columns already want
        // (`distribute_span`). col0 = 30 → topped to 50 by the first span; col2 = 20 → topped to 40 by the
        // second; col1 stays 0 both times (it wants nothing, and its neighbour takes the whole deficit).
        let inputs = vec![
            tbl(0.0, -1, 0.0, 0.0),
            rowgroup(1.0, 0),
            rowel(2.0, 1),
            cell(3.0, 2, 50.0, 20.0, 0, 2, 1), // cols 0-1
            cell(4.0, 2, 20.0, 20.0, 2, 1, 1), // col 2
            rowel(5.0, 1),
            cell(6.0, 5, 30.0, 20.0, 0, 1, 1), // col 0
            cell(7.0, 5, 40.0, 20.0, 1, 2, 1), // cols 1-2
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[0].w, bx[0].h], [90.0, 40.0]); // 50 + 0 + 40 ; two 20px rows
        assert_eq!([bx[3].x, bx[3].w], [0.0, 50.0]);  // row0: the 0-1 span
        assert_eq!([bx[4].x, bx[4].w], [50.0, 40.0]); // row0: col 2
        assert_eq!([bx[6].x, bx[6].w], [0.0, 50.0]);  // row1: col 0
        assert_eq!([bx[7].x, bx[7].w], [50.0, 40.0]); // row1: the 1-2 span
    }

    // t4 — the caption (a block box, the table's only non-row/-group child). The `<table>` box is the WRAPPER:
    // a top caption offsets the whole grid down by its own height; a bottom one sits below the grid; a caption
    // needing more than the grid floors the wrapper's width. The caption here is a plain block child of the table
    // declaring a border-box size (`caption()`) — measure_table finds it structurally, not by a display code.
    fn caption(nid: f64, parent: i32, w: f64, h: f64) -> Input {
        let mut c = item(nid, parent, w, h);
        c.decl_w = w; // what its min-content contribution — the wrapper's floor — reads
        c.decl_border_box = true;
        c
    }
    #[test]
    fn table_caption_top_offsets_the_grid_down() {
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table (wrapper); caption_side top (0 = default)
            caption(1.0, 0, 100.0, 16.0),      // 1 caption (block, 100x16)
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3 td col 0
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4 td col 1
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
            caption(1.0, 0, 100.0, 16.0),      // 1 caption
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
            caption(1.0, 0, 300.0, 16.0),      // 1 caption, wider than the 152 grid
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 300.0); // wrapper widened to the caption
        assert_eq!(bx[0].h, 44.0);
        // …and the columns share out that width: the surplus over their 60/80 maximums goes to them in
        // proportion (288 assignable − 140 = 148 → 60 + 63.43 and 80 + 84.57), so the grid fills the wrapper.
        assert_eq!([bx[3].x, bx[4].x], [4.0, 131.42857142857142]);
    }

    // A caption on a table with its OWN border sits at the WRAPPER's border box — outside the border, not inset
    // into the content box: x=0 / y=0 at the top-left, the full border-box width, and the
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
            caption(1.0, 0, 60.0, 16.0),       // 1 caption, the width of the border box (40 cell + 2*10)
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 40.0, 20.0, 0, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
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
            caption(1.0, 0, 60.0, 16.0),       // 1 caption
            rowel(2.0, 0),
            cell(3.0, 2, 40.0, 20.0, 0, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[3].x, bx[3].y], [10.0, 10.0]); // grid at the top, inside the border (no top caption)
        assert_eq!([bx[1].x, bx[1].y], [0.0, 40.0]); // caption below the bottom border: bt(10)+grid_h(20)+bb(10)
    }

    // A wide caption on a bordered table floors the wrapper to the caption's border box — it does NOT add the
    // table border on TOP of it: caption 300 → wrapper 300, not 320, and the content box the columns share out is
    // 280 (300 - the two borders).
    #[test]
    fn table_caption_wider_than_a_bordered_grid_does_not_re_add_the_border() {
        let mut t = tbl(0.0, -1, 0.0, 0.0);
        t.bl = 10.0;
        t.br = 10.0;
        t.bt = 10.0;
        t.bb = 10.0;
        let inputs = vec![
            t,
            caption(1.0, 0, 300.0, 16.0),       // 1 caption, spans the border box it grows to 300
            rowel(2.0, 0),
            cell(3.0, 2, 280.0, 20.0, 0, 1, 1), // 3 td filling the floored content box (300 - 2*10)
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 300.0); // NOT 320 — the caption border box IS the wrapper, the border is not re-added
        assert_eq!([bx[1].x, bx[1].w], [0.0, 300.0]);
        assert_eq!([bx[3].x, bx[3].w], [10.0, 280.0]);
    }

    // An AUTO-width caption fills the wrapper, and a PERCENTAGE one is a fraction of it — floor nothing (a `%` is
    // indefinite while the table's width is being decided), so one over 100% overflows the table without growing
    // it, and in rtl hangs off its left edge.
    #[test]
    fn table_caption_auto_fills_and_a_percentage_overflows_the_wrapper() {
        for (pct, rtl, want) in [(f64::NAN, 0, [0.0, 152.0]), (1.5, 0, [0.0, 228.0]), (1.5, 1, [-76.0, 228.0])] {
            let mut t = tbl(0.0, -1, 4.0, 4.0);
            t.rtl = rtl;
            let mut cap = blk(1.0, 0);
            cap.pct_sizes[0] = pct;
            let inputs = vec![
                t,
                cap,
                rowel(2.0, 0),
                cell(3.0, 2, 60.0, 20.0, 0, 1, 1),
                cell(4.0, 2, 80.0, 20.0, 1, 1, 1),
            ];
            let bx = boxes(layout_block(&inputs, &[], &[], &[], 0.0, 0.0, 800.0));
            assert_eq!(bx[0].w, 152.0); // the grid's own border box
            assert_eq!([bx[1].x, bx[1].w], want);
        }
    }

    // `intrinsic_widths` reads the DECLARED sizing (decl_*), never the used box a push wrote into width/min_w/
    // max_w/border_box: a flex item pushed to a 100-wide used box with an auto declared width measures from its
    // content (a 40-wide declared child), and a declared border-box width pins the box less nothing.
    #[test]
    fn intrinsic_widths_reads_declared_not_pushed_sizing() {
        let mut root = blk(0.0, -1);
        root.display = DISPLAY_FLEX;
        let mut flex_item = blk(1.0, 0);
        flex_item.width = 100.0; // the flex push
        flex_item.border_box = true;
        flex_item.min_w = f64::NAN;
        let mut child = blk(2.0, 1);
        child.decl_w = 40.0;
        child.pl = 5.0;
        child.pr = 5.0;
        // The basis-less edges are their own input, like `decl_w` — and they must be set beside any `pl` / `pr`,
        // or `pct_edges_x()` reads the whole padding as a percentage.
        child.decl_edges_x = 10.0;
        let mut pinned = blk(3.0, 0);
        pinned.decl_w = 70.0;
        pinned.decl_border_box = true;
        pinned.pl = 10.0;
        pinned.decl_edges_x = 10.0;
        pinned.width = 200.0; // pushed, ignored
        let inputs = [root, flex_item, child, pinned];
        let children = vec![vec![1, 3], vec![2], vec![], vec![]];
        assert_eq!(intrinsic_widths(1, &inputs.map(Cell::new), &[], &[], &[], &children), Some((50.0, 50.0)));
        assert_eq!(intrinsic_widths(3, &inputs.map(Cell::new), &[], &[], &[], &children), Some((70.0, 70.0)));
        // the row sums its items: 50 + 70, plus the main gap between them
        root.flex_main_gap = 8.0;
        let inputs = [root, flex_item, child, pinned];
        assert_eq!(intrinsic_widths(0, &inputs.map(Cell::new), &[], &[], &[], &children), Some((128.0, 128.0)));
    }

    // A row item's flex-basis pins its contribution, or — when the item may grow — only raises its max; the
    // item's own min/max-width then clamp; a wrapping row's min is its widest item.
    #[test]
    fn flex_intrinsic_basis_grow_and_wrap() {
        let mut root = blk(0.0, -1);
        root.display = DISPLAY_FLEX;
        let mut a = blk(1.0, 0);
        a.decl_w = 60.0;
        a.flex_basis = 30.0; // pinned at the basis (no grow)
        let mut b = blk(2.0, 0);
        b.decl_w = 20.0;
        b.flex_basis = 50.0;
        b.flex_grow = 1.0; // max raised to the basis, min stays the content
        let mut c = blk(3.0, 0);
        c.decl_w = 90.0;
        c.decl_max_w = 40.0; // capped
        let inputs = [root, a, b, c];
        let children = vec![vec![1, 2, 3], vec![], vec![], vec![]];
        assert_eq!(intrinsic_widths(0, &inputs.map(Cell::new), &[], &[], &[], &children), Some((30.0 + 20.0 + 40.0, 30.0 + 50.0 + 40.0)));
        root.flex_wrap = true;
        let inputs = [root, a, b, c];
        assert_eq!(intrinsic_widths(0, &inputs.map(Cell::new), &[], &[], &[], &children), Some((40.0, 120.0)));
        root.flex_wrap = false;
        root.flex_main_is_x = false; // a column: the widest item
        let inputs = [root, a, b, c];
        assert_eq!(intrinsic_widths(0, &inputs.map(Cell::new), &[], &[], &[], &children), Some((60.0, 60.0)));
    }
}
