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
// …and the same slack for the justify cut, which is a DIFFERENT question — which gaps hang off the line's
// end — asked of the same two differently-accumulated sums. Named apart so retuning the fit allowance (to
// 1/64px, say, to match a LayoutUnit) cannot silently start swallowing gaps.
//
// ABSOLUTE, and that is a decision rather than an oversight. The two engines work in DIFFERENT FRAMES — the
// oracle from the page origin, this one from the content edge — so a tolerance relative to the coordinate is
// a different absolute slack in each, which is the asymmetry it exists to remove. The cost is a measured
// ceiling: past 2²⁴ one ULP of the oracle's page coordinate exceeds 1e-9 and the cut decides on the bits
// again (a 16,777,216px page offset puts this engine's atomic at 16777321.6 against the oracle's 16777360).
// Not reachable on a real page, and the frame asymmetry behind it is wider than this line — the fit test has
// it too — so it is recorded rather than papered over here.
const GAP_CUT_EPS: f64 = 1e-9;
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
    // …where its own inset is a PERCENTAGE, the walk sends the pairs instead and `with_percent_sizes` writes
    // `rel_x` / `rel_y` from them: [x fraction (NaN = nothing to resolve), `top` fraction (NaN = no percentage),
    // `top` length (NaN = auto), the same two for `bottom`, and what the record's rec[39..40] carried — the
    // inline boxes' shift, plus the horizontal length part]. `top` wins where it resolves; a percentage one does not
    // against an indefinite height, and `bottom` is used then — the oracle's `relativeOffset`, where such a `top`
    // resolves to nothing. The base is kept apart because the resolved box REPLACES the input, and a box measured
    // again must not add its offset twice.
    pub(crate) rel_pct: [f64; 7],
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
    // A PUSHED item of a MULTI-LINE flex container: its line's NATURAL cross size, before `align-content` grew it
    // (the oracle's `stackFlexLines`). A pushed box is final, so where its line mixes stretching and fixed items
    // the stretched boxes already contain a share of the grow and the line cannot be rebuilt from them. NaN = not
    // sent (a natively-sized container, a nowrap one, a non-flex parent).
    pub(crate) flex_line_nat: f64,
    // …and WHICH line the oracle put it on (its index in flow order): lines break on the items' HYPOTHETICAL
    // sizes, which a pushed box no longer is — an item the line shrank no longer overflows, and re-breaking the
    // final sizes kept the next item beside it. NaN = not sent.
    pub(crate) flex_line: f64,
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
    // Caption placement (t4), on a table's CAPTION node: 0 = caption-side top (stacked above the grid, which is
    // offset down past every top caption), 1 = bottom (stacked below the grid). The caption's box is laid out by
    // `measure_table`; the `<table>` el._lb is then the WRAPPER (captions + grid). 0 on every other node.
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
    // FLEX ONLY since 2026-09-22 — a GRID sends 0. Its bare run is a real anonymous ITEM in a row now (CSS
    // Grid §4), so the row carries the height and the floor could only override a declared `grid-auto-rows`,
    // which it did: 22 against Chrome's 5, in both engines, where the same grid with the text in a `<span>`
    // gave 5. When flex gets its item, this field goes with it.
    pub(crate) anon_cross: f64,
    // A block's OWN `white-space` mode — a text block's, and since 2026-09-24 a block container's too, whose
    // intrinsic measure PINS min to max under 1 / 2 (`content_intrinsic`): 0 normal, 1 nowrap, 2 pre, 3 pre-wrap, 4 pre-line,
    // 5 break-spaces. The three orthogonal behaviours it names — COLLAPSE whitespace (0/1/4) vs PRESERVE it
    // (2/3/5), SOFT-WRAP at break opportunities (0/3/4/5) vs never (1/2), a NEWLINE forcing a break (2/3/4/5)
    // — belong to the RUN they are
    // about, so `line_layout` reads those off `Run::ws_mode`. What it still asks of the BLOCK is whether the
    // LINE may break at all (`outerWraps`: a non-wrapping RUN forbids breaks inside itself, the opportunity
    // before it is the block's to give), `pin` in `text_intrinsic` ("a box that never wraps has its
    // max-content for a min-content", which the oracle asks of the element), and the mode an empty block and
    // the anonymous groups are read under.
    // 5 shares 3's triple, which is why `line_layout` needs no arm of its own for it: a line under
    // `break-spaces` is a line under `pre-wrap`. The two part in the INTRINSIC measure alone — every
    // preserved space is content that never hangs, with a break after each — which `text_intrinsic`'s `modes`
    // gives 5 a tuple of its own for, rather than measuring it by 3's rule.
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
    // resolved against the container's main size, or — beside a `flex_basis_frac` — the constant term that
    // fraction is added to (NaN = auto / a keyword — `flex_basis_kw` 0 none, 1 content,
    // 2 min-content, 3 max-content, 4 fit-content); whether the item scrolls across (its automatic minimum in
    // that axis is then zero, §4.5, and its baseline is clamped into its box); whether it STRETCHES in the
    // cross axis (`align-self: stretch` with an auto cross size and no auto cross margin). On a CONTAINER,
    // `flex_native` = the items' main sizes are computed here (`flex_row_sizes` / `flex_column_sizes`) rather
    // than pushed from the oracle.
    pub(crate) flex_shrink: f64,
    pub(crate) flex_basis_cb: f64,
    // A PERCENTAGE `flex-basis` as a fraction of the container's main size (NaN = none), resolved here
    // (`flex_basis_at`) over the constant term `flex_basis_cb` carries beside it (a linear `calc()`'s; 0 for a
    // plain percentage) — and a container's main / cross gap percentages, over the px parts in
    // `flex_main_gap` / `flex_cross_gap`. The walk used to resolve all three against the oracle's box.
    pub(crate) flex_basis_frac: f64,
    // The plain PERCENTAGES among width / height / min-width / max-width / min-height / max-height, as fractions
    // of the containing block (NaN = that size is a length or auto, already in its own field). The parent resolves
    // them when it lays this box out (`with_percent_sizes`), writing the result into those fields.
    pub(crate) pct_sizes: [f64; 6],
    // …and the CONSTANT term beside each of those fractions, for a percentage inside a LINEAR `calc()`:
    // `calc(50% + 10px)` is `10 + 0.5 x basis`. 0 for a plain percentage. It is a field of its own rather than
    // the already-declared size, because `with_percent_sizes` WRITES its answer into `width` / `height` / … and
    // is run again at another basis (a grid item re-resolved at its track width) — a constant read back out of
    // the resolved field would be added once per resolve.
    pub(crate) pct_px: [f64; 6],
    // …and the BOUNDS of each, where the size is a comparison function over affine operands (`min(50%, 60px)` is
    // `0.5 x basis` capped at 60): `clamp(lo, px + frac x basis, hi)`, each bound a (px, frac) pair of its own —
    // the clamped-affine value the gaps and the indent already carry. (-inf, 0) / (+inf, 0) where unbounded.
    pub(crate) pct_lo: [(f64, f64); 6],
    pub(crate) pct_hi: [(f64, f64); 6],
    // …and the margins' and padding's percentage parts (margin top / right / bottom / left, padding top / right /
    // bottom / left) as fractions of the containing-block WIDTH, 0 where there is none, beside the length parts the
    // walk sent (`edge_px`, kept apart from the fields a resolution overwrites).
    pub(crate) edge_frac: [f64; 8],
    pub(crate) edge_px: [f64; 8],
    // An out-of-flow box's inset percentages (top / right / bottom / left) as fractions of its containing block's
    // padding box — height for top / bottom, width for left / right — beside the length parts in `inset_*`.
    pub(crate) inset_frac: [f64; 4],
    pub(crate) flex_main_gap_frac: f64,
    // …and the BOUNDS of a clamped-affine value, which is what a comparison function over one affine operand
    // is: `min(10%, 20px)` is `10%` capped at 20, `clamp(5px, 10%, 12px)` is `10%` between 5 and 12. The pair
    // alone cannot express one, and the oracle resolves them, so every figure that can be written that way
    // carries lo/hi beside its pair and both engines evaluate `clamp(lo, px + frac * basis, hi)`.
    // Each bound is a `(px, frac)` PAIR of its own, because a bound can vary with the basis too:
    // `min(10%, 20%)` is one line capped by another. +-INFINITY px with a 0 fraction where there is no bound,
    // so the clamp is the identity and a plain length is unaffected.
    pub(crate) flex_main_gap_lo: (f64, f64),
    pub(crate) flex_main_gap_hi: (f64, f64),
    pub(crate) flex_cross_gap_lo: (f64, f64),
    pub(crate) flex_cross_gap_hi: (f64, f64),
    pub(crate) indent_lo: (f64, f64),
    pub(crate) indent_hi: (f64, f64),
    pub(crate) flex_cross_gap_frac: f64,
    pub(crate) flex_basis_kw: u8,
    pub(crate) scrolls_x: bool,
    pub(crate) scrolls_y: bool,
    // A `<button>`: as wide as its CONTENT wants, whatever display it has and however much room it is given
    // (HTML's button layout IS shrink-to-fit — `block_child_width` routes an auto-width one through the
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
    // Whether `height` is a USED size settled OUTSIDE this box — a flex line's cross size, an inset box's, a
    // pushed replay — rather than its own declaration. Only a TABLE reads it, and the two differ for one: a
    // DECLARED height is shared out over the rows with the caption stacked on top (Chrome: `height: 120px` plus
    // an 18px caption is 138 tall), while an imposed one is the WRAPPER's, the caption inside it (a stretched
    // flex item is exactly as tall as its line).
    pub(crate) height_from_outside: bool,
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
    // TABLE CELL: it holds a PERCENTAGE-height descendant, so it may need a SECOND layout at the final row
    // height for that descendant to have a basis (§17.5.3 — the oracle's `pass2`). The walk answers it: the
    // question runs down a subtree of DECLARATIONS, stopping at a definite-height child and at a nested table
    // (each is its own percentages' containing block), and native may not walk that subtree at all.
    pub(crate) cell_pct_h_child: bool,
    // A mixed block's ANONYMOUS GROUP (§9.2.1.1, the walk's record for a run of its inline content): a box the
    // oracle has no box for, whose inline content's containing block is the mixed block itself. So the percentage
    // HEIGHTS of what it holds resolve against the basis the mixed block hands its own children (`group_pct_h`,
    // written by that block when it measures its children), never against the group's own auto height.
    pub(crate) anon_group: bool,
    pub(crate) group_pct_h: f64,
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
    // …unless it LAYS OUT CHILDREN: a `<select multiple>` showing rows is a replaced box whose SIZE is the
    // control's chrome (`replaced_box`) and whose CONTENT is its options, stacked as ordinary blocks inside it
    // (Chrome gives each option a box; a dropdown's have none at all). Its box is pinned from the intrinsic data
    // and the block path lays the rows out inside it.
    pub(crate) lays_out_children: bool,
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
    // `text-indent`: the LENGTH part, and the percentage as a FRACTION of the block's own content width, which
    // the flow resolves (`line_layout`) and an INTRINSIC measure does not — a percentage has nothing to resolve
    // against before the box has been given any room (CSS Sizing 3), so `text_intrinsic` takes the length alone.
    pub(crate) indent_px: f64,
    pub(crate) indent_frac: f64,
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
    // ancestor above the pass root — its PADDING BOX arrives instead, in the pass's own (document) coordinates:
    // `cb_index` is CB_RECT and these four are x / y / width / height. `place_out_of_flow` reads one or the other
    // and does the same arithmetic either way, so the only difference between a viewport-positioned box and an
    // in-pass one is where the rectangle came from. A relatively-positioned INLINE of the pass is neither: it has
    // no record, but native lays its fragments out, so `cb_index` is CB_INLINE and `cb_rect[0]` its index in the
    // pass's inline table (`inline_padding_box`).
    pub(crate) cb_rect: [f64; 4],
}
// `cb_index` for a box that has no containing block of this kind — an in-flow one.
pub(crate) const CB_NONE: i32 = -1;
// …for an out-of-flow box whose containing block is not in the pass but whose RECTANGLE is (cb_rect).
pub(crate) const CB_RECT: i32 = -2;
// …and for one whose containing block is an inline box of the pass, named by its inline-table index in cb_rect[0].
pub(crate) const CB_INLINE: i32 = -3;

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
// A FLOAT written in this text block's inline content (`font` = its record): a block box wherever it was written,
// placed in the float context where the flow has reached — the top of the line it interrupts — and the rest of
// that line routes around it. No advance, no line growth, no break opportunity.
pub(crate) const RUN_FLOAT: u8 = 7;

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
    // A TEXT run's line-height; on a CLOSE edge, the inline's font CONTENT height (`fontContentHeight`), the
    // box a landing close grows the line to — a content box, not a line-height, whatever the name says.
    pub(crate) line_height: f64,
    // An ascent above the line's baseline, whatever the kind: a TEXT run's, an ATOMIC's (its own baseline plus
    // any shift), and a CLOSE edge's — the inline's own FONT box, `vertical-align` shift included, which a
    // landing close grows the line to (with `line_height` its height; see `RUN_CLOSE`).
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
    // How an ATOMIC hangs on its line, where that is not a question about its own ascent: 0 by its ascent
    // (`asc`, which every other `vertical-align` has already folded into), 1 the LINE BOX's top, 2 its bottom.
    // The two line-relative values cannot be an ascent, because the line's height is not known until every run
    // on it is placed — so such a box contributes none, raises `line_outer_min` instead, and is placed at the
    // line close. CSS 2.1 §10.8.1; the oracle's `growAtomic` / `forceBreak` pair.
    // Its own field rather than one of the slots an ATOMIC leaves unread (`ls`, `ws`, `tab_px`, `tab_min`):
    // `line_height` and `metric` are already overloaded on this kind — they arrive as the alignment code and
    // the parent-font figure and leave as the box's outer height and advance — and a third reused slot is how
    // that pair became hard to read. One `f64` per run in the buffer; the perf gate held.
    pub(crate) line_mode: u8,
    // A CLOSE edge that MAY land on the line: either of its two halves (border + padding, then margin) has a
    // length or a percentage in it, whatever they sum to — it lands where one of them is still non-zero once
    // resolved in the line's block (`line_layout`). The oracle places the halves as two edges (`placeInlineBox`:
    // `if (ce.right)` and `if (ce.mr)`), so `padding-right:5px; margin-right:-5px` puts a line down — Chrome gives
    // the block 22 — where a test on the SUM saw nothing. Carried in the buffer slot an edge leaves unread
    // (`line_mode`'s), so the stride is unchanged; false on every other kind.
    pub(crate) lands: bool,
    // An OPEN / CLOSE edge's width with NO percentage basis — what an INTRINSIC measure reads, where an OPEN's
    // `metric` is the LENGTH part the laid-out line adds its percentages to (their fractions ride the inline table,
    // `InlineBox`). 0 on every other kind.
    pub(crate) plain: f64,
}

impl Input {
    // An out-of-flow box native positions from its containing block (vs one whose oracle box is replayed).
    fn native_oof(&self) -> bool {
        self.out_of_flow != 0 && self.cb_index != CB_NONE
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
    // …clamped by the min/max the RECORD carries, which for a TABLE CELL are none in its block axis: they do not
    // apply there at all (CSS 2.2 §17.5.3 leaves their effect undefined; Chrome and Firefox read both as `auto`),
    // and the walk says so (`cellIgnoresMinMax`). The box's `box_h` clamps by the same record, and the two have to
    // agree, because this figure is the basis the cell's own PERCENTAGE-height descendants resolve against on its
    // second pass: a `max-height: 20px` cell in a 200px table hands its `height: 50%` child a basis of 97, as the
    // oracle and Chrome both say, not 20. A cell in a VERTICAL writing mode is the other way round — its height
    // is its inline axis, and its min/max-height clamp it (80, not its 18px line; Chrome ignores the max under a
    // declared height, which both engines share).
    fn definite_content_h(&self) -> Option<f64> {
        if is_auto(self.height) || self.item_auto_height || self.pushed_h_indefinite {
            return None;
        }
        let to_border = |v: f64| if is_auto(v) || self.border_box { v } else { v + self.edges_y() };
        let border_h = clamp_min_max(to_border(self.height), to_border(self.min_h), to_border(self.max_h));
        Some((border_h.max(0.0) - self.edges_y()).max(0.0))
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
        // `frac * basis + px`, the same pair the EDGES resolve two lines below (`edge_px + edge_frac * cb_w`):
        // `px` is 0 for a plain percentage and the constant term of a linear `calc()` otherwise.
        let at = |i: usize, frac: f64, basis: f64, current: f64| {
            if frac.is_nan() {
                current
            } else if is_auto(basis) {
                f64::NAN
            } else {
                // …never below zero: a size is non-negative, and only a math function can produce a negative
                // one (`calc(10% - 100px)` in 300px is a zero content box, its padding still around it).
                clamp_affine(frac * basis + self.pct_px[i], self.pct_lo[i], self.pct_hi[i], basis).max(0.0)
            }
        };
        let [w, h, min_w, max_w, min_h, max_h] = self.pct_sizes;
        n.width = at(0, w, cb_w, n.width);
        n.height = at(1, h, cb_h, n.height);
        n.min_w = at(2, min_w, cb_w, n.min_w);
        n.max_w = at(3, max_w, cb_w, n.max_w);
        n.min_h = at(4, min_h, cb_h, n.min_h);
        n.max_h = at(5, max_h, cb_h, n.max_h);
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
        n.with_relative_insets(cb_w, cb_h)
    }
    // …and a `position: relative` box's percentage insets, onto the base the record carried — apart from the sizes
    // for the one box whose two bases differ: a table CAPTION, whose `%` height resolves against nothing while its
    // offset resolves against the table's height (`measure_table`).
    fn with_relative_insets(self, cb_w: f64, cb_h: f64) -> Input {
        let mut n = self;
        let [x_frac, top_frac, top_px, bottom_frac, bottom_px, base_x, base_y] = self.rel_pct;
        if !x_frac.is_nan() {
            // An inset resolves to nothing where it is `auto` (a NaN length), to its length where it has no
            // percentage (a NaN fraction), to the pair where the height is definite, and to nothing otherwise — a
            // `0%` included, which is why "no percentage" cannot be a zero fraction.
            let at = |px: f64, frac: f64| {
                if px.is_nan() {
                    None
                } else if frac.is_nan() {
                    Some(px)
                } else if is_auto(cb_h) {
                    None
                } else {
                    Some(px + frac * cb_h)
                }
            };
            let y = at(top_px, top_frac).or_else(|| at(bottom_px, bottom_frac).map(|b| -b)).unwrap_or(0.0);
            n.rel_x = base_x + if x_frac == 0.0 { 0.0 } else { x_frac * cb_w };
            n.rel_y = base_y + y;
        }
        n
    }
    fn has_percent_sizes(&self) -> bool {
        self.pct_sizes.iter().any(|f| !f.is_nan()) || self.edge_frac.iter().any(|&f| f != 0.0) || !self.rel_pct[0].is_nan()
    }
    // A flex item's resolved basis in a container whose main size is `main`: its percentage of that plus the
    // constant beside it (auto where the main size is indefinite), else the length the walk resolved.
    fn flex_basis_at(&self, main: f64) -> f64 {
        if self.flex_basis_frac.is_nan() {
            self.flex_basis_cb
        } else if is_auto(main) {
            f64::NAN
        } else {
            self.flex_basis_frac * main + self.flex_basis_cb
        }
    }
    fn edges_y(&self) -> f64 {
        self.pt + self.pb + self.bt + self.bb
    }
    // A box with no `_nid`: a mixed block's anonymous text-block group, an anonymous table row or cell, an
    // anonymous grid item. NOT "it has no element" — `anonTableCell` and `anonGridItem` build real objects the
    // oracle stamps a real `_lb` on, and layout.js says so where they are built. What they have in common is
    // that they are no part of the DOM, so there is no arena id to read a box back by, which is why the walk
    // marks them `rec[0] = -1` and the parity compare skips them.
    // Named here so a rule that depends on it says so, rather than testing the sentinel in place and leaving
    // the next reader to work out which of the four kinds it meant — and every such rule should ask WHICH,
    // because the four have nothing else in common (see `block_child_width`'s use).
    //
    // BACKLOG, and it would remove a whole class rather than exempt one member of it: the anonymous group
    // carries `block_axis_is_x` only so `from_right` can pair it with the direction, and the WALK has already
    // computed the answer (`startsInlineAtRight`). Send that bit instead and the group can answer `false` to
    // the width question honestly — no exemption, and nothing for a future anonymous kind to fall into.
    fn is_anonymous(&self) -> bool {
        self.nid < 0.0
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
    // Whether an AUTO height's min/max clamp MOVED it — its content was laid out against the height it came to,
    // not the one it was cut to (the oracle's `_lbClampedH`), so a definite question asking for that same number
    // is not answered by laying it out at auto again (`flex_column_sizes`).
    pub(crate) clamped_h: bool,
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
    LaidOut(Vec<Box>, Vec<FragRow>),
    Unsupported,
}

// An inline box the run stream opens — its entry in the walk's inline table (`nlInlineEntry`), which the OPEN /
// CLOSE / WBR runs name by index in their `font` slot: the box's own figures, which its FRAGMENTS are laid out
// from (the oracle's `settleInlineBoxes`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct InlineBox {
    // The horizontal edges the line meets that the OPEN run's sum does not split: the opening margin (the fragment
    // starts past it) and the two closing halves, border + padding and margin (the fragment holds only the first).
    pub(crate) ml: f64,
    pub(crate) right: f64,
    pub(crate) mr: f64,
    // …and the vertical ones, which grow every fragment past the box's own font box without touching the line.
    pub(crate) top: f64,
    pub(crate) bottom: f64,
    // The box's own font CONTENT height and its ascent above the line's baseline (`inlineAscent`).
    pub(crate) own_h: f64,
    pub(crate) own_asc: f64,
    // The `position: relative` offset accumulated down the inline chain, which moves the fragments at paint time.
    pub(crate) rel_x: f64,
    pub(crate) rel_y: f64,
    // Its borders, which its padding box — an out-of-flow descendant's containing block — lies inside.
    pub(crate) bt: f64,
    pub(crate) br: f64,
    pub(crate) bb: f64,
    pub(crate) bl: f64,
    // The edges' PERCENTAGES, as fractions of the content width of the block laying the line out (§8.3/8.4: an inline
    // box's margins and padding resolve against its containing block's width) beside the length parts above and on
    // the OPEN run: margin-left, the opening border + padding, then the closing halves and the vertical edges.
    pub(crate) f_ml: f64,
    pub(crate) f_left: f64,
    pub(crate) f_right: f64,
    pub(crate) f_mr: f64,
    pub(crate) f_top: f64,
    pub(crate) f_bottom: f64,
}
impl InlineBox {
    // Its edges resolved in a block `content_w` wide, the fractions folded into the lengths.
    fn resolved(mut self, content_w: f64) -> InlineBox {
        self.ml += self.f_ml * content_w;
        self.right += self.f_right * content_w;
        self.mr += self.f_mr * content_w;
        self.top += self.f_top * content_w;
        self.bottom += self.f_bottom * content_w;
        self
    }
}
// …and what native answers for one: [inline index, x, y, w, h] per fragment, in document coordinates.
pub(crate) type FragRow = [f64; 5];

// One line an inline box's content landed on — the oracle's `frag.lines` record (`notePlacement`): the leftmost
// extent it reached there (`minX`, which starts past the box's own opening margin), the right edge of what it
// placed, and of what HANGS at the line's end (a collapsible space a break may still eat). `top` / `asc` are the
// line's own, stamped when it closes (`lineRecords[index]`), which is what puts the fragment on the line's baseline.
struct FragLine {
    line_no: usize,
    top: f64,
    min_x: f64,
    max_right: f64,
    hang_right: f64,
    hang_pending: bool,
    asc: f64,
}
// …and the box itself as the line layout sees it: where it OPENED (the oracle's `frag.x` / `frag.y` / `frag.line`,
// which an EMPTY box's fragment is read off), and whether the line it opened on became a line (`onLine`).
struct Frag {
    idx: usize,
    ib: InlineBox,
    lines: Vec<FragLine>,
    open_x: f64,
    open_top: f64,
    open_line: usize,
    on_line: bool,
}
// One box still OPEN on the line layout's stack: its opening edge (margin + border + padding), whether that has gone
// down on a line yet, and its `Frag`.
struct OpenBox {
    w: f64,
    placed: bool,
    frag: usize,
}
// The pass's inline table, and each record's inline fragments as its text block laid them out — [inline index,
// x, y, w, h] in the block's border-box frame until `place` moves them into the document's. Pass-local
// (installed by `layout_block`, like `IW_MEMO`) because a text block is measured from deep inside the recursion,
// which would otherwise carry the table through every call, and because only a block's LAST measure is its layout,
// exactly as with `boxes`.
struct FragPass {
    table: Vec<InlineBox>,
    rows: Vec<Vec<FragRow>>,
    // …and which record's rows hold each inline box's fragments (`usize::MAX`: none laid out yet).
    owner: Vec<usize>,
}
thread_local! {
    static FRAG_PASS: std::cell::RefCell<Option<FragPass>> = const { std::cell::RefCell::new(None) };
}
struct FragStore(Option<FragPass>);
impl FragStore {
    fn install(table: &[InlineBox], records: usize) -> Self {
        FragStore(FRAG_PASS.with(|m| {
            m.borrow_mut().replace(FragPass { table: table.to_vec(), rows: vec![Vec::new(); records], owner: vec![usize::MAX; table.len()] })
        }))
    }
    // What the pass laid out, in record order, once `place` has put every fragment in the document's frame.
    fn take() -> Vec<FragRow> {
        FRAG_PASS.with(|m| m.borrow_mut().as_mut().map(|p| p.rows.iter_mut().flat_map(std::mem::take).collect()).unwrap_or_default())
    }
}
impl Drop for FragStore {
    fn drop(&mut self) {
        FRAG_PASS.with(|m| *m.borrow_mut() = self.0.take());
    }
}
// An inline box's entry — the default where no pass installed a table (a unit test's bare `line_layout`).
fn inline_box(idx: usize) -> InlineBox {
    FRAG_PASS.with(|m| m.borrow().as_ref().and_then(|p| p.table.get(idx).copied())).unwrap_or(InlineBox {
        ml: 0.0, right: 0.0, mr: 0.0, top: 0.0, bottom: 0.0, own_h: 0.0, own_asc: 0.0,
        rel_x: 0.0, rel_y: 0.0, bt: 0.0, br: 0.0, bb: 0.0, bl: 0.0,
        f_ml: 0.0, f_left: 0.0, f_right: 0.0, f_mr: 0.0, f_top: 0.0, f_bottom: 0.0,
    })
}
fn store_frags(i: usize, rows: Vec<FragRow>) {
    FRAG_PASS.with(|m| {
        if let Some(p) = m.borrow_mut().as_mut() {
            if i < p.rows.len() {
                for r in &rows {
                    if let Some(o) = p.owner.get_mut(r[0] as usize) {
                        *o = i;
                    }
                }
                p.rows[i] = rows;
            }
        }
    });
}
// The PADDING box of inline box `k` as a containing block (CSS 2.1 §10.1): from its FIRST fragment's top-left to
// its LAST one's bottom-right — not their union — less its borders (the oracle's `paddingBoxOf` over
// `inlineContainingBox`). Asked by `place_out_of_flow`, after `place` has moved the fragments into the document's
// frame: the record that laid them out is an ancestor of every box inside the inline.
fn inline_padding_box(k: usize) -> Option<(f64, f64, f64, f64)> {
    FRAG_PASS.with(|m| {
        let pass = m.borrow();
        let p = pass.as_ref()?;
        let rows = p.rows.get(*p.owner.get(k)?)?;
        let mut own = rows.iter().filter(|r| r[0] as usize == k);
        let first = *own.next()?;
        let last = own.last().copied().unwrap_or(first);
        let ib = p.table.get(k)?;
        Some((
            first[1] + ib.bl,
            first[2] + ib.bt,
            (last[1] + last[3] - first[1] - ib.bl - ib.br).max(0.0),
            (last[2] + last[4] - first[2] - ib.bt - ib.bb).max(0.0),
        ))
    })
}
// …and moved with the box that holds them: by `place` into the document's frame, by a table cell's
// `vertical-align` shift, which moves a cell's CONTENT and not its box.
fn shift_frags(i: usize, dx: f64, dy: f64) {
    FRAG_PASS.with(|m| {
        if let Some(rows) = m.borrow_mut().as_mut().and_then(|p| p.rows.get_mut(i)) {
            for r in rows.iter_mut() {
                r[1] += dx;
                r[2] += dy;
            }
        }
    });
}

// Lay out `inputs` (a flat buffer, parent-indexed, the root at index 0) starting from the root's
// border-box origin + width the caller fixes (from the viewport / initial containing block). Returns a
// box per node in input order. Block flow: each block fills its containing block's content width (auto)
// or takes its declared width; in-flow block children stack vertically at the content origin; auto
// height is the children's stacked height (plus this box's own vertical edges).
pub(crate) fn layout_block(inputs: &[Input], runs: &[Run], run_texts: &[Option<Vec<u16>>], grids: &[f64], inlines: &[InlineBox], root_x: f64, root_y: f64, root_cb_w: f64) -> Outcome {
    if inputs.is_empty() {
        return Outcome::LaidOut(Vec::new(), Vec::new());
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
        .map(|n| Box { nid: n.nid, x: 0.0, y: 0.0, w: 0.0, h: 0.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None, clamped_h: false })
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
    let _frag_guard = FragStore::install(inlines, inputs.len());
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
    // The inline boxes' fragments, each laid out by the text block its runs belong to and placed with it. A box no
    // text block answered for is left out, which the harness counts as MISSING: every tabled box belongs to a
    // committed stream, so an absent one is a bug to see, not a box to guess at.
    Outcome::LaidOut(boxes, FragStore::take())
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

// A collapsed space waiting for the next word. Its `sep` is the question every reader below is really
// asking — IS THIS A WORD SEPARATOR — and each of them asked it of the WIDTH instead until 2026-09-20,
// which conflates two different things: a zero-advance pending space is normally the break OPPORTUNITY a
// `pre` run (or a `nowrap` run's collapsed leading space) leaves behind, and no separator; but a REAL space
// whose advance cancels to zero (`word-spacing: -9.6px` on a 9.6px space) is one. The oracle has no width
// test anywhere here — what it mirrors is `placeOnLine(…, hangs)`, which pushes a gap and sets
// `lineEndsWithSpace` because a collapsible space was PLACED, whatever it measured. Native dropped every gap
// on such a line (its atomic at 19.2 against the oracle's and Chrome's 25.27), broke the line in two where
// both said one, and kept a preserved run alive past the space that ends it.
//
// A STRUCT rather than the tuple it started as, for the reason `LineStyle` below gives: `breaks` and `sep`
// are adjacent `bool`s read through positional wildcards at a dozen sites, and transposing them compiles
// clean while quietly rejustifying every page.
#[derive(Clone, Copy)]
struct PendingSpace {
    w: f64,
    asc: f64,
    desc: f64,
    // Whether a soft wrap may fall here — the QUEUING run's to say, not the consuming one's: the oracle
    // leaves a `barrier` of `'hard'` behind a non-wrapping run's trailing space, so
    // `aaa <span style="white-space:normal">bbbbbbbb</span>` in a `nowrap` block does not break before the
    // span however the span itself wraps.
    breaks: bool,
    // Whether it is a word separator at all, as against a zero-width break opportunity.
    sep: bool,
    // Already ON the line: its advance and its gap went down where an edge was placed after it (a closing or an
    // opening edge the oracle puts down after the space it had placed where it met it), and what still waits
    // is only what the space IS for the next word — its break opportunity, its metrics, and that a line
    // ending in it starts the next run's white space collapsed. `w` is 0 once placed.
    placed: bool,
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
// opportunity. OPEN/CLOSE are an inline element's horizontal edges: OPEN reserves its opening edge (`metric` and
// the table's percentages, resolved in this block) in the fit test (openEdgeWidth) and flushes onto the first line
// content lands on; CLOSE adds the box's closing halves (from its `InlineBox`) on the current line. BR forces a line break. A line's box is max(ascent)+max(descent) over the STRUT
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
// A FLOAT in the stream itself (RUN_FLOAT, its box already measured in `inline_floats`, in stream order) is
// placed into `floats` where the flow reaches it, so every band asked for after it sees it.
#[allow(clippy::too_many_arguments)]
fn line_layout(
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    strut_lh: f64,
    strut_asc: f64,
    content_w: f64,
    floats: &mut Vec<FloatItem>,
    inline_floats: &[FloatBox],
    cl: f64,
    cr: f64,
    top: f64,
    style: LineStyle,
) -> Option<LineLayout> {
    let LineStyle {ws_mode, align, rtl, indent} = style;
    // (A Cell for the same reason `indent_now` is one: the band closures read the context the float arm writes.)
    let floats = std::cell::RefCell::new(floats);
    // The three orthogonal `white-space` behaviours (see Input::ws_mode), as ONE closed table rather than
    // three predicates spelling out their own code lists. `no_wrap` keeps the old name for the soft-wrap gates
    // below, and it is what a space writes into its own break OPPORTUNITY, because the opportunity belongs to
    // the run that queued the space, not to whatever meets it. `preserve` keeps every space as a real advance
    // rather than collapsing runs of whitespace to one break-opportunity; `break_nl` makes a literal newline
    // force a break in a COLLAPSING run (the preserving branch breaks on its own newlines regardless, so 2 / 3
    // / 5 never ask it — it is `pre-line`'s question).
    // …asked of the RUN that the behaviour is about, because an inline may declare its own `white-space`
    // (`Run::ws_mode`), and every run in the stream carries its owner's — the `<br>` and edge runs included.
    //
    // A table, and an `Option`, for the same reason `text_intrinsic`'s `modes` is one: `WS_MODE` in `layout.js`
    // is the only producer of these codes, and the day it grows one this has to REFUSE rather than guess. The
    // predicates this replaced were three different shapes of guess — `m == 1 || m == 2` closed, `m >= 2` open
    // — so a new code would have been given `pre-line`'s newline rule by an inequality nobody would have
    // re-read. `break-spaces` (5) is 3's triple exactly; the pair that has to move together is this table and
    // `text_intrinsic`'s.
    let ws_modes = |m: u8| match m {
        0 => Some((false, false, false)),   // normal      — collapse, wrap
        1 => Some((true, false, false)),    // nowrap      — collapse, never wrap
        2 => Some((true, true, true)),      // pre         — preserve, never wrap, newline breaks
        3 => Some((false, true, true)),     // pre-wrap    — preserve, wrap, newline breaks
        4 => Some((false, false, true)),    // pre-line    — collapse, wrap, newline breaks
        5 => Some((false, true, true)),     // break-spaces— as pre-wrap for a LINE; parts only in the measure
        _ => None,
    };
    // The block's own mode decides whether the LINE may break at all; a non-wrapping RUN forbids breaks inside
    // itself, but the opportunity before it is the block's to give.
    let outer_wraps = !ws_modes(ws_mode)?.0;
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
        if floats.borrow().is_empty() {
            content_w
        } else {
            let (bl, br) = float_band(&floats.borrow(), top + t, strut_lh, cl, cr);
            br - bl
        }
    };
    // …and where that band starts, from the content edge (0 with no floats). The indent moves the START edge,
    // which in rtl is the RIGHT one: the origin is the band's left either way, so in rtl the narrowing shows up
    // only in the width — which `close_line`'s `free` already carries into the alignment shift — and adding it
    // to the origin too would move the line twice.
    let raw_band_l = |t: f64| -> f64 {
        if floats.borrow().is_empty() {
            0.0
        } else {
            float_band(&floats.borrow(), top + t, strut_lh, cl, cr).0 - cl
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
    // …and WHICH of this line's gaps the collapsible hang began at, for the justify cut: the gaps from there on
    // hang, the ones before are between words. By ORDER, as the oracle's `hangGapIndex`: an edge after the hang
    // (a closing margin) moves the pen without ending it, and a negative one moves it back past a real gap, so
    // no coordinate says where the hang began.
    let mut hang_gap: Option<usize> = None;
    let mut total = 0.0f64;
    // How many lines have CLOSED. A marker waiting on an opening edge recorded the cursor it stood at; that
    // cursor still means something only while its line is still open — a wrap since then starts it over.
    let mut line_no = 0usize;
    // The current line's box, seeded to the strut and grown by each placed run's ascent / descent.
    let mut line_asc = strut_asc;
    let mut line_desc = strut_desc;
    // What a LINE-RELATIVE atomic (`vertical-align: top` / `bottom`) asks of the line: not an ascent or a
    // descent — it hangs from an edge the line does not have yet — but a HEIGHT the line must reach. The
    // oracle's `lineOuterMin` / `growLineFor`.
    let mut line_outer_min = 0.0f64;
    // Two questions about the line, which the oracle keeps apart as `linePlaced` / `lineHasContent` and
    // native had folded into one until it cost a parity break: whether the line EXISTS (anything at all went
    // down on it, an inline's opening or closing edge included) and whether it holds something a break may
    // leave BEHIND. An edge answers only the first — it is not content, so a line holding nothing but one
    // is no line a break-before test may end: `<span style="padding-left:6px"></span><b inline-block>` on a
    // 6px line keeps the atomic beside the edge and overflows, where asking the one flag broke before it.
    // Every break-before test asks `line_has_content`; everything else — the line's close, its alignment,
    // a float drop, a leading space's collapse — asks `line_placed`, each where its oracle counterpart does.
    let mut line_placed = false;
    let mut line_has_content = false;
    // The INLINE BOXES this stream opens, laid out as FRAGMENTS the way the oracle's `placeInlineBox` /
    // `notePlacement` / `settleInlineBoxes` lay them out: every box in open order, and the boxes this line holds pieces
    // of (`lineFrags`), left empty (`lineEmpties`) or has a hanging space in (`lineHangs`), for the close to shift and
    // settle.
    let mut frags: Vec<Frag> = Vec::new();
    // …and the ones still OPEN, innermost last (the oracle's `openInlines`), each with its opening edge and whether
    // that has gone down yet — the unplaced ones' sum is `openEdgeWidth`, reserved in the fit test until the first
    // content flushes it onto the line.
    let mut open: Vec<OpenBox> = Vec::new();
    let mut line_frags: Vec<usize> = Vec::new();
    let mut line_empties: Vec<usize> = Vec::new();
    let mut line_hangs: Vec<usize> = Vec::new();
    // One placement held by box `$f` — the oracle's `notePlacement`: a fresh line record where the box has none on
    // this line yet (its extent starting past `$inset`, the box's own opening margin), then its leftmost extent, and
    // the right edge of what it placed or of what HANGS (a collapsible space a break may still eat).
    macro_rules! note {
        ($f:expr, $from:expr, $to:expr, $hangs:expr, $inset:expr) => {{
            let fi: usize = $f;
            let (from, to): (f64, f64) = ($from + $inset, $to);
            let f = &mut frags[fi];
            if f.lines.last().map_or(true, |l| l.line_no != line_no) {
                f.lines.push(FragLine {
                    line_no,
                    top: total,
                    min_x: from,
                    max_right: f64::NEG_INFINITY,
                    hang_right: f64::NEG_INFINITY,
                    hang_pending: false,
                    asc: 0.0,
                });
                line_frags.push(fi);
            }
            let l = f.lines.last_mut().expect("a line record was just made");
            if from < l.min_x {
                l.min_x = from;
            }
            if $hangs {
                if !l.hang_pending {
                    l.hang_pending = true;
                    line_hangs.push(fi);
                }
                if to > l.hang_right {
                    l.hang_right = to;
                }
            } else if to > l.max_right {
                l.max_right = to;
            }
        }};
    }
    // …and a placement every OPEN box holds (`placeOnLine`'s `for (const frag of openInlines)`).
    macro_rules! note_open {
        ($from:expr, $to:expr, $hangs:expr) => {{
            if !open.is_empty() {
                let (from, to): (f64, f64) = ($from, $to);
                for a in 0..open.len() {
                    note!(open[a].frag, from, to, $hangs, 0.0);
                }
            }
        }};
    }
    // Move the pen past a placement `$w` wide, and say where it began and ended — the end read as the pen's new
    // `band_l + line_x`, the very sum every justification gap is read as, never as `at + $w`: the two differ in the
    // last bit, and a piece ending exactly where the next gap begins then counted that gap as one BEFORE its end
    // and moved by a whole extra share of the spread (46.4 where the oracle and Chrome say 28).
    macro_rules! advance {
        ($w:expr) => {{
            let at = band_l(total) + line_x;
            line_x += $w;
            (at, band_l(total) + line_x)
        }};
    }
    // The oracle's `dropHangs`: content after a hanging space keeps it on the line (`false`); a line that closes eats
    // it (`true`).
    macro_rules! drop_hangs {
        ($eaten:expr) => {{
            for fi in line_hangs.drain(..) {
                if let Some(l) = frags[fi].lines.last_mut() {
                    if $eaten {
                        l.hang_right = f64::NEG_INFINITY;
                    }
                    l.hang_pending = false;
                }
            }
        }};
    }
    let mut pending_space: Option<PendingSpace> = None;
    // An inline box OPENING where the flow stands, as the oracle's `placeInlineBox` records it (`x: lineX`, past a
    // collapsed space still pending, which the oracle has already placed where it met it): that is where an EMPTY
    // one sits.
    macro_rules! frag_here {
        ($idx:expr) => {{
            let idx: usize = $idx;
            Frag {
                idx,
                ib: inline_box(idx).resolved(content_w),
                lines: Vec::new(),
                open_x: band_l(total) + line_x + pending_space.map_or(0.0, |p| p.w),
                open_top: total,
                open_line: line_no,
                on_line: false,
            }
        }};
    }
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
    // Where each JUSTIFICATION gap sits on the current line — the origin of every space the line placed (a
    // preserved run contributes one per character, as Chrome widens a double space twice). A wrapped line shares
    // its free space out over the gaps BEFORE its content ends, and everything on the line moves by the gaps that
    // precede it (the oracle's `lineGaps` / `alignLine`). Only boxes are compared, so only their offsets are
    // settled here; the glyphs between them are the painter's business.
    let mut line_gaps: Vec<f64> = Vec::new();
    // …and the separators a NON-WRAPPING run ENDS in, held back: they are gaps only once a placement follows them
    // on the line (the oracle's `tailGaps` — a `pre` run's trailing space at a wrap is the line's end and takes
    // no share, Chrome-measured). A line that closes discards them.
    let mut tail_gaps: Vec<f64> = Vec::new();
    // Every one of these is JUSTIFY's bookkeeping and nothing else reads it, so a block that does not justify
    // pays nothing for it (rule 3: the hot path stays what it was).
    let justifying = align == 3;
    macro_rules! note_gap {
        ($x:expr) => {{
            if justifying {
                line_gaps.push($x);
            }
        }};
    }
    // A collapsible space goes down on the line and HANGS there until content follows it: its advance, and — a
    // real separator, not a zero-width opportunity — its justification gap, the index the hang began at, and the
    // end of any run of preserved spaces before it (the oracle's `placeOnLine(…, hangs)`).
    macro_rules! hang_space {
        ($sep:expr, $w:expr) => {{
            if $sep {
                if hang_gap.is_none() {
                    hang_gap = Some(line_gaps.len());
                }
                note_gap!(band_l(total) + line_x);
                hang_pre = 0.0;
            }
            line_x += $w;
            hang += $w;
        }};
    }
    // A collapsed space still pending goes down now, as a HANG, before the edge or break that comes next: the oracle
    // placed it where it met it (dropped with a break instead, it moved every edge the break puts down back by its
    // width). The space, for a site that keeps it pending as the zero-width opportunity it leaves.
    macro_rules! place_pending_space {
        () => {{
            let p = pending_space.filter(|p| p.sep && !p.placed);
            if let Some(p) = p {
                hang_space!(true, p.w);
            }
            p
        }};
    }
    // A placement that is not an edge and does not hang turns the held-back separators into real gaps.
    macro_rules! flush_tail_gaps {
        () => {{
            if justifying && !tail_gaps.is_empty() {
                line_gaps.append(&mut tail_gaps);
            }
        }};
    }
    // A NO-BREAK SPACE is no break opportunity, but it IS a justification gap — CSS Text 3 §8.1, and Chrome
    // widens one like an ordinary space (the oracle's `noteGapsInside` on any placed unit holding one). The pen
    // inside the placed text is where it sits. …and one the unit ENDS in is held back like any trailing
    // separator (`tail_gaps`): it is a gap once something follows it on the line, and nothing where the line
    // wraps right after it — `aa&nbsp;` closing a justified line spreads nothing over its own end.
    macro_rules! note_nbsp_gaps {
        ($run:expr, $slice:expr, $base:expr) => {{
            let s: &[u16] = $slice;
            if justifying {
                if s.contains(&0xA0) {
                    for j in 0..s.len() {
                        if s[j] == 0xA0 {
                            let pen = $base + measure_at($run, &s[..j], $base)?;
                            tail_gaps.push(pen);
                        } else {
                            flush_tail_gaps!();
                        }
                    }
                } else {
                    flush_tail_gaps!(); // (a word is a non-separator throughout)
                }
            }
        }};
    }
    let mut line_atomics: Vec<(usize, f64, usize)> = Vec::new();
    let mut atomics: Vec<PlacedAtomic> = Vec::new();
    // …and the same for the OUT-OF-FLOW markers on the line (record index, x from the content edge, the relative
    // offset of the inlines around it, y): their static position is the inline offset the flow had reached and
    // the line's TOP, both settled at close so the line's alignment moves them exactly as it moves the atomics —
    // by the gaps before the FLOW's x, which the relative offset is no part of (it moves the content at paint
    // time, after the line is laid out): counted with it, a `left: 3px` inline gave a marker glued to a word the
    // justification gap right after that word (64.2 where the oracle and Chrome say 57.6).
    let mut line_oofs: Vec<(usize, f64, f64, f64)> = Vec::new();
    let mut oofs: Vec<(usize, f64, f64)> = Vec::new();
    // …and the markers that cannot know that yet, because an inline box around them still holds an UNPLACED
    // opening edge: (record index, the inlines' relative offset x / y, the cursor and line to fall back on).
    // Where the flow has reached is then wherever that edge turns out to be placed — which may be a later line
    // — exactly the oracle's `pendingStatic`, settled from the inline's first fragment.
    let mut pending_oofs: Vec<(usize, f64, f64, usize, f64, usize)> = Vec::new();
    // Where each inline FLOAT landed: (record index, border-box x, border-box y), in the float context's frame.
    let mut placed_floats: Vec<(usize, f64, f64)> = Vec::new();
    let mut next_float = 0usize;
    // Close the current line: `$wrap` says a soft wrap closed it (its hanging white space is not part of the
    // line's extent; a hard break keeps preserved spaces before it), and `$forced` that a `<br>` or a preserved
    // newline did (the oracle's `sawBreak`). The line's atomics move by the alignment
    // (the oracle's `alignLine`): `right` takes the free width, `center` half — clamped at zero in ltr, where an
    // overflowing line stays at the start edge; in rtl the overflow hangs off the LEFT, so the shift goes negative.
    macro_rules! close_line {
        ($wrap:expr, $forced:expr) => {{
            // The inline boxes' pieces first, in the oracle's `forceBreak` order: a space still hanging at the end
            // is eaten, and a box left EMPTY that OPENED on this line — closed or not — learns whether the line is
            // one (`onLine`), which a forced break makes it even with nothing on it (Chrome).
            drop_hangs!(true);
            let on_line = line_placed || $forced;
            for &fi in &line_empties {
                frags[fi].on_line = on_line;
            }
            for o in &open {
                let f = &mut frags[o.frag];
                if f.lines.is_empty() && f.open_line == line_no {
                    f.on_line = on_line;
                }
            }
            // The line-relative boxes are settled FIRST, because they can move the line's own ascent — which
            // everything below reads: the baselines this block hands its container, and where every
            // baseline-aligned box on the line lands. The oracle does the same, in `forceBreak`, before it
            // stamps `lastLineAsc`.
            //
            // The line grows AWAY from whichever edge asked for the most room (Chrome): a 40px `top` box
            // beside a 30px `bottom` one takes the line to 40 with its baseline where it already was, where
            // letting the `bottom` box decide dropped every word on the line by 22px. Only the LARGER of the
            // two families moves anything, and it moves the edge it is NOT anchored to.
            if line_placed && line_outer_min > line_asc + line_desc {
                let (mut max_top, mut max_bottom) = (0.0f64, 0.0f64);
                for &(ri, ..) in &line_atomics {
                    match runs[ri].line_mode {
                        1 => max_top = max_top.max(runs[ri].line_height),
                        2 => max_bottom = max_bottom.max(runs[ri].line_height),
                        _ => {}
                    }
                }
                // …which is `line_outer_min` again, by construction: both are maxima over exactly the runs
                // with a line mode. The second test is the oracle's shape (`forceBreak`), kept so the two read
                // alike; what the scan is actually FOR is `max_top` vs `max_bottom`, which decides which edge
                // moves.
                let need = max_top.max(max_bottom);
                if need > line_asc + line_desc {
                    if max_bottom > max_top {
                        line_asc = need - line_desc;
                    } else {
                        line_desc = need - line_asc;
                    }
                }
            }
            let line_h = line_asc + line_desc;
            if first_line.is_none() {
                first_line = Some((total, line_asc));
            }
            last_line = Some((total, line_asc));
            // The collapsible hang comes off EVERY line's end, the preserved one only a wrapped line's — the oracle's
            // `trailingHang + (kind === 'wrap' ? trailingPreserved : 0)`. (A forced close had no collapsible hang
            // to take off until a space pending at an edge started going down BEFORE the edge.)
            let end = line_x - hang - if $wrap { hang_pre } else { 0.0 };
            let free = band_w(total) - end;
            // `justify` (align 3) spreads the free space over this line's gaps — only a line that WRAPPED, with
            // room to give and a gap that is not the hanging one at its end (CSS Text 3 §7.1; the last line and
            // one a `<br>` or a newline ends keep their natural spacing). A line it leaves alone is START-aligned.
            let end_x = if justifying { band_l(total) + end } else { 0.0 };
            // The hanging gaps are the ones the line ENDS with, which is a question about ORDER —
            // `line_gaps` is pushed in flow order — not about x: a negative horizontal margin can carry a
            // later gap to a smaller coordinate, and a coordinate cut then keeps it and drops one before it.
            let gaps: Vec<f64> = if justifying && $wrap && free > 0.0 && line_placed {
                // …to a TOLERANCE, for the reason `LINE_FIT_EPS` exists beside it: a gap's origin and the
                // line's end are the same sum in different accumulation orders — this engine forms the end as
                // `band_l + (line_x - hang - hang_pre)` and the oracle as `(band_l + line_x) - hang` — so a gap
                // sitting EXACTLY at the end decides on the last bit, and one ULP there costs a whole gap's
                // share of the free space. It is the only one of this line's four float tests whose two sides
                // travel different routes; the others compare a gap against a pen off the same running
                // variable, and coincide bit-exactly within each engine.
                let hangs = match hang_gap {
                    Some(i) => i.min(line_gaps.len()),
                    None => line_gaps.iter().position(|&g| g >= end_x - GAP_CUT_EPS).unwrap_or(line_gaps.len()),
                };
                line_gaps[..hangs].to_vec()
            } else {
                Vec::new()
            };
            let extra = if gaps.is_empty() { 0.0 } else { free / gaps.len() as f64 };
            // A line the flow never put anything on is not aligned at all (the oracle's `forceBreak` calls
            // `alignLine` only `if (linePlaced)`): a `<br>` closing a line that holds nothing but an
            // out-of-flow marker leaves that marker at the start edge, not at the far one.
            let dx = if !line_placed {
                0.0
            } else {
                match align {
                    1 => if rtl { free } else { free.max(0.0) },
                    2 => if rtl { (free / 2.0).min(free) } else { (free / 2.0).max(0.0) },
                    // …a `justify` line the spread leaves alone starts at the inline-start edge, which in rtl is
                    // the far one (the oracle's `align = rtl ? 'right' : 'left'`).
                    3 => if extra > 0.0 { 0.0 } else if rtl { free } else { 0.0 },
                    _ => 0.0,
                }
            };
            // What moves an item on a justified line is how many gaps lie BEFORE it, each widened by `extra` —
            // counted when it was placed, because nothing later can recover it from a coordinate: the box's own
            // horizontal margin and its `position: relative` offset both carry its x across gap boundaries
            // while leaving the gaps before it exactly as they were. (Chrome puts a `margin-left: -12px`
            // atomic that OPENS a justified line at −12; counting by x gave it a gap it comes before.)
            let shift_box = |before: usize| if extra > 0.0 { before.min(gaps.len()) as f64 * extra } else { dx };
            // An out-of-flow MARKER is not a box on the line — it records a static position, which may sit
            // after a space the line has not placed yet (`pending_w`), so its gap count is not the one taken
            // when it was recorded. It keeps the coordinate rule, which is what the oracle's `lineStatics`
            // uses; the two engines have to ask the same question. (Where that rule is wrong, both are wrong
            // together — see the campaign note.)
            let shift_at = |x: f64| if extra > 0.0 { gaps.iter().filter(|&&g| g < x).count() as f64 * extra } else { dx };
            for (run, x, before) in line_atomics.drain(..) {
                atomics.push(PlacedAtomic { run, x: x + shift_box(before), line_top: total, line_asc, line_h });
            }
            // A marker's Y was frozen where it was recorded (the oracle reads `staticX`/`staticY` together and
            // only ever shifts x afterwards): a line that later DROPS below a float moves `total`, and the box
            // does not go with it. Only the alignment reaches it here.
            for (ci, x, rx, y) in line_oofs.drain(..) {
                oofs.push((ci, x + shift_at(x) + rx, y));
            }
            // …and the inline boxes' pieces on it, by the same COORDINATE rule the markers use (the oracle's
            // `moveLine` asks `shiftFor` of a piece's `minX` and right edges, not how many gaps precede it), then
            // stamped with the line's ascent — which is what puts each piece on the line's baseline. A box with no
            // piece yet that opened here (`here(frag)`: this line, this top) moves with it too.
            if line_placed {
                for &fi in &line_frags {
                    if let Some(l) = frags[fi].lines.last_mut().filter(|l| l.line_no == line_no) {
                        l.min_x += shift_at(l.min_x);
                        if l.max_right.is_finite() {
                            l.max_right += shift_at(l.max_right);
                        }
                        if l.hang_right.is_finite() {
                            l.hang_right += shift_at(l.hang_right);
                        }
                    }
                }
                for fi in line_empties.iter().copied().chain(open.iter().map(|o| o.frag)) {
                    let f = &mut frags[fi];
                    if f.lines.is_empty() && f.open_line == line_no && f.open_top == total {
                        f.open_x += shift_at(f.open_x);
                    }
                }
            }
            for &fi in &line_frags {
                if let Some(l) = frags[fi].lines.last_mut().filter(|l| l.line_no == line_no) {
                    l.asc = line_asc;
                }
            }
            line_frags.clear();
            line_empties.clear();
            line_gaps.clear();
            hang_gap = None;
            tail_gaps.clear();
            total += line_h;
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
    // The oracle's `flushOpenEdges`: every pending edge goes down, one fragment at a time, each asked of its
    // own width (`if (!w) continue`). A pair that cancels still places BOTH — the pen ends where it began,
    // which is not the same thing as leaving them pending for someone else's sum to pick up later.
    //
    // The oracle calls this FOUR ways and two of them are different questions, which native had folded into
    // one macro until it cost a bug: at a box's CLOSE and at a forced BREAK it calls `flushOpenEdges()`
    // outright, while `placeOnLine` asks `if (pending)` — the SUM — first. Folded together under the sum, a
    // cancelling pair stayed pending at a close and the OUTER close then flushed an unbalanced sum
    // (`<span ml:-6><span pl:6></span></span>` put the next box at -6, Chrome and the oracle at 0).
    // So: this macro at the three DIRECT sites, `flush_open_edges!` at the `placeOnLine`-shaped ones. The
    // two are indistinguishable by every instrument we have (~28,000 sweep cases, both spec files) at the
    // word / atomic sites, which once spelled it out by hand a third way; each is used where its ORACLE
    // counterpart is, because that is the only thing that decides it.
    // …and each edge that goes down is a placement: the box it opens and every box around it hold it, the box
    // itself from past its own opening margin (`notePlacement(openInlines[a], …, a === i ? ce.ml : 0)`).
    macro_rules! flush_each_open_edge {
        () => {{
            for k in 0..open.len() {
                if open[k].placed {
                    continue;
                }
                let w = open[k].w;
                if w != 0.0 {
                    let (at, to) = advance!(w);
                    line_placed = true;
                    let ml = frags[open[k].frag].ib.ml;
                    for a in 0..=k {
                        note!(open[a].frag, at, to, false, if a == k { ml } else { 0.0 });
                    }
                }
                open[k].placed = true;
            }
        }};
    }

    // …and `placeOnLine`'s `if (pending)` around it, for the sites that are its counterparts: the sum is
    // what the content has to FIT, and where the pending edges cancel there is nothing to place.
    macro_rules! flush_open_edges {
        () => {{
            let total_open: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
            if total_open != 0.0 {
                flush_each_open_edge!();
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
                    let edges: f64 = open.iter().take(depth).filter(|o| !o.placed).map(|o| o.w).sum();
                    if rtl {
                        // …an rtl corner included. Its x is the container's edge and never was the cursor's,
                        // but its y IS the static position — which for a marker that waited is the line the
                        // inline's edge landed on, the relative offset dropped with it, exactly as in ltr.
                        oofs.push((ci, content_w + rx, total));
                    } else {
                        line_oofs.push((ci, base + edges, 0.0, total));
                    }
                }
            }
        }};
    }
    // …and start a fresh one.
    macro_rules! soft_break {
        () => {{
            close_line!(true, false);
            line_x = 0.0; // (`hang` is reset by the content the wrap moves onto the fresh line)
            line_asc = strut_asc;
            line_desc = strut_desc;
            line_outer_min = 0.0;
            line_has_content = false;
            line_placed = false;
        }};
    }
    // An EMPTY line — no CONTENT on it — too narrow for what is about to go on it drops below the float squeezing
    // it (§9.5), growing the block by the gap: the oracle's `retakeBand(need)`. A line holding only an inline box's
    // EDGES is such a line too, and Chrome leaves the edge on it and sends the content below the float at its left,
    // so that line closes first (a wrap) and the fresh one drops (x 0 where both engines overflowed at 35).
    // `$w` is what has to fit, open edges included; the indent is added here, as the band leaves it out.
    macro_rules! drop_below_floats {
        ($w:expr) => {{
            let w = $w;
            // (…from where the pen stands on an edge-only line: a negative edge moves it back, and a word behind
            // one fits a band its width alone does not — the oracle's `used`.)
            let used = if line_placed { line_x } else { 0.0 };
            if !floats.borrow().is_empty() && !line_has_content && used + w > band_w(total) + LINE_FIT_EPS {
                let fy = top + total;
                if float_fit_y(&floats.borrow(), fy, w + indent_now.get(), cl, cr, strut_lh) > fy {
                    if line_placed {
                        soft_break!();
                    }
                    let fy = top + total;
                    let at = float_fit_y(&floats.borrow(), fy, w + indent_now.get(), cl, cr, strut_lh);
                    if at > fy {
                        total += at - fy;
                    }
                }
            }
        }};
    }
    macro_rules! break_line {
        () => {{
            close_line!(false, true);
            line_x = 0.0;
            hang = 0.0;
            hang_pre = 0.0;
            line_asc = strut_asc;
            line_desc = strut_desc;
            line_outer_min = 0.0;
            line_has_content = false;
            line_placed = false;
            pending_space = None;
            atomic_break = false;
            ends_open = false;
        }};
    }

    for (ri, run) in runs.iter().enumerate() {
        match run.kind {
            RUN_OPEN => {
                let f = frag_here!(run.font as usize);
                // (…the opening edge: its length parts on the run, its percentages in the table.)
                let w = run.metric + (f.ib.f_ml + f.ib.f_left) * content_w;
                frags.push(f);
                open.push(OpenBox { w, placed: false, frag: frags.len() - 1 });
            }
            RUN_CLOSE => {
                // Nothing landed inside it, so the box shows its edges where it OPENED. The oracle flushes
                // the WHOLE open stack at the close of any box whose own opening edge is still pending
                // (`if (frag.pendingOpen) flushOpenEdges()`, "Chrome gives a lone padded empty `<span>` a
                // 10x27 box on its line") — native dropped it instead, under a comment claiming that matched
                // JS. It never did: `<span style="padding-left:6px"></span>` puts the next box at 6 in the
                // oracle and in Chrome and at 0 here, and an out-of-flow child of such a box read the cursor
                // BEFORE the edge rather than past it. Both were invisible, behind the walk's
                // `edged-inline-without-content` refusal — which named a line-box height as its cause, and
                // this is not that.
                // Settled BEFORE the flush, as at every other flush site: a marker's own edges are the ones
                // still unflushed, so reading them after would add nothing.
                // …and flushed PER FRAGMENT, not behind the sum guard: the oracle asks `if (frag.pendingOpen)`
                // here — this box's own edge — and then places every pending one, cancelling pairs included.
                let flushes = open.last().is_some_and(|o| !o.placed && o.w != 0.0);
                // An edge put down here goes AFTER a collapsed space still pending: the oracle placed that space
                // where it met it, so the space's advance and its justification gap come BEFORE the edge. Kept
                // pending, native placed both after it, and a marker inside the inline — past the space, before
                // the gap — was not moved by the spread (48 where the oracle and Chrome say 60.4).
                // …and whether the close LANDS: a half the walk saw a length or a percentage in, still there once it is
                // resolved (a `calc()` cancelling to nothing in this block lands nothing, as in the oracle).
                let closing = &frags[open.last()?.frag].ib;
                let lands = run.lands && (closing.right != 0.0 || closing.mr != 0.0);
                if flushes || lands {
                    if let Some(p) = place_pending_space!() {
                        pending_space = Some(PendingSpace { w: 0.0, placed: true, ..p });
                    }
                }
                if flushes {
                    settle_pending_oofs!();
                    flush_each_open_edge!();
                }
                let own = open.pop()?.frag; // LIFO (a CLOSE with nothing open is no stream the walk makes)
                // The closing edge goes down as its two halves, as the oracle places them (`if (ce.right)`, then
                // `if (ce.mr)`): the border and padding inside the box, which the box itself holds, then the margin
                // outside it, which only the boxes around it do.
                let (right, mr) = (frags[own].ib.right, frags[own].ib.mr);
                if right != 0.0 {
                    let (at, to) = advance!(right);
                    note!(own, at, to, false, 0.0);
                    note_open!(at, to, false);
                }
                if mr != 0.0 {
                    let (at, to) = advance!(mr);
                    note_open!(at, to, false);
                }
                // (…an empty one that opened on an earlier line already has its answer, from that line's close.)
                if frags[own].lines.is_empty() && frags[own].open_line == line_no {
                    line_empties.push(own);
                }
                // Neither `hang` nor `hang_pre` is cleared: an edge is `edge` to the oracle, which leaves the
                // spaces before it hanging (`trailingHang` is reset only `if (!edge)`) — only a real placement
                // ends their run.
                // A close that LANDS is an edge PLACEMENT, and the oracle's `placeOnLine` grows the line for one
                // like any other non-hanging placement: first by the metrics of the collapsible space hanging at
                // the line's end — banked here, so a wrap that drops the space still leaves the line as tall —
                // then by the inline's own FONT box (`fontContentHeight` at `inlineAscent`), which is taller than
                // its line-height contribution wherever the font's content area is (Chrome: an empty
                // `font-size:30px; padding-right:5px` span makes a 16px line 41 tall, not 22).
                if lands {
                    line_placed = true;
                    if let Some(p) = pending_space.filter(|p| p.sep) {
                        line_asc = line_asc.max(p.asc);
                        line_desc = line_desc.max(p.desc);
                    }
                    line_asc = line_asc.max(run.asc);
                    line_desc = line_desc.max(run.line_height - run.asc);
                }
            }
            RUN_BR => {
                // The oracle's `<br>` puts every opening edge still pending down on the line it ENDS
                // (`flushOpenEdges()` outright, then `forceBreak()` — Chrome gives `<span style="padding-left:20px">
                // <br>b</span>` two fragments, the first that padding), which is exactly what the preserved-newline
                // arm does: settle the markers waiting on those edges, flush them DIRECT, break. The inline then
                // continues on the next line with its edge already down, and its CLOSE lands there. This used to
                // decline any open edge (`br-in-edged-inline` in the walk) as a fragment native could not place;
                // it never needed to.
                settle_pending_oofs!();
                // …the edges this break puts down landing after a collapsed space still pending, as at a close.
                place_pending_space!();
                flush_each_open_edge!();
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
                    let below = clearance_y(&floats.borrow(), fy, clear);
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
                let (no_wrap, preserve, break_nl) = ws_modes(ws_mode)?;
                // A run that does not wrap is placed WHOLE by the oracle, one newline segment at a time: ONE
                // `placeOnLine` — which turns the separators held back before it into gaps — and then
                // `noteGapsInside` over its body, which holds each separator back in turn until a non-separator of
                // the body follows it (a body ENDING in separators leaves them held). Native places such a run piece by
                // piece, so it keeps the same books: its first piece flushes (`body_started`), and after that a
                // separator is held and a non-separator flushes — a collapsed space INSIDE the body included
                // (`body_space`), which is no hang at the line's end. Counting those at once put a marker after
                // `<span style="white-space:nowrap">?\n&nbsp;…</span>` at the end of a justified line (45 where the
                // oracle and Chrome say 28.8).
                let mut body_started = false;
                let mut body_space = false;
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
                // A run of collapsible white space that is not a `pre-line` newline's: ONE space where it collapses
                // into content, nothing (but its break opportunity) where it does not.
                macro_rules! collapse_space {
                    () => {{
                        if !line_has_content {
                            // At a line start — no CONTENT on it yet; an inline box's edges alone do not
                            // end it (the oracle's `lineHasContent`) — the space itself collapses away, but
                            // the BARRIER it leaves does not: the oracle sets `barrier` from a whitespace-only
                            // run whether or not it placed anything (`modeWraps(owner) ? null : 'hard'`). A non-wrapping run
                            // leaves HARD, which an atomic after it may neither break at nor drop below a
                            // float at; a wrapping one leaves null, which CLEARS whatever stood there.
                            // No metrics as well as zero width: nothing was placed, so nothing grows the
                            // line box — a taller space that collapsed away was raising the line by its own
                            // leading. And NO metrics is `-inf`, the identity for a max, not zero (the
                            // oracle's `lineHangAsc` says why): ZERO is a height, and at a line-height below
                            // the font box the line's descent is NEGATIVE, so a word taking this placeholder
                            // on a line an edge had started grew `line-height: 8px` to 10.
                            ends_open = false;
                            atomic_break = false;
                            pending_space = if no_wrap {
                                Some(PendingSpace { w: 0.0, asc: f64::NEG_INFINITY, desc: f64::NEG_INFINITY, breaks: false, sep: false, placed: false })
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
                                Some(ps) if ps.sep => {
                                    if !no_wrap && !ps.breaks {
                                        pending_space = Some(PendingSpace { breaks: true, ..ps });
                                    }
                                }
                                // …otherwise this space takes the slot: either nothing was waiting, or all
                                // that was is the zero-width OPPORTUNITY a preserved space left behind
                                // (the oracle's `lineEndsWithSpace` is false after one, so it places this
                                // space like any other).
                                _ => {
                                    // The oracle PLACES it where it meets it (`placeInlineChild`'s
                                    // whitespace branch, under the `linePlaced` this `line_placed` is),
                                    // and placing anything puts the open inline edges down first. So the
                                    // edges go down HERE — and a marker written after them is not waiting
                                    // on anything, which is what lets it keep the relative offset of its
                                    // own inline. The space's ADVANCE still only waits (one the next wrap
                                    // drops grows nothing), but the line holds CONTENT from here on:
                                    // `placeOnLine` sets `lineHasContent` for anything but an edge, and a
                                    // non-wrapping run's pre-pass asks that before any word consumes the
                                    // space — after an edge-only line, ` <nowrap>aaaa</nowrap>` in a 30px
                                    // block stayed on the line where the oracle wraps it.
                                    settle_pending_oofs!();
                                    flush_open_edges!();
                                    // …and it is the oracle's placement of it, as a HANG, which every open box
                                    // holds from here: the space itself only waits (below), but where it will
                                    // sit is where the flow stands now.
                                    // (…its end read as the pen will read it once the space is placed.)
                                    note_open!(band_l(total) + line_x, band_l(total) + (line_x + space_w), true);
                                    // …and it REPLACES the opportunity the text before it left (a hyphen,
                                    // a wide character): the oracle overwrites `barrier` at any trailing
                                    // white space. Whether it breaks is ITS OWN mode's to say — the
                                    // whitespace-only-node arm is `modeWraps(owner) ? null : 'hard'`.
                                    ends_open = false;
                                    atomic_break = false;    // …as above: one barrier, and this is it now
                                    pending_space = Some(PendingSpace { w: space_w, asc: run.asc, desc: run.line_height - run.asc, breaks: !no_wrap, sep: true, placed: false });
                                    body_space = no_wrap;
                                    line_has_content = true;
                                }
                            }
                        }
                    }};
                }
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
                        && (pending_space.is_some_and(|p| p.breaks) || atomic_break || ends_open);
                    let may_drop = !line_has_content && !floats.borrow().is_empty();
                    if breaks || may_drop {
                        let end = if break_nl {
                            text.iter().position(|&u| u == 0x0A).unwrap_or(text.len())
                        } else {
                            text.len()
                        };
                        // The oracle strips a run's LEADING white space only at a line start, which is an
                        // empty line or one already ending in a real hanging space (`collapseRun`'s
                        // `!linePlaced || lineEndsWithSpace`). Anywhere else it stays in the body and
                        // in the width the fit test is asked of. A PRESERVED space is not a hanging one, so
                        // the zero-width marker does not count.
                        // …and only a COLLAPSING run ever asks: a preserved space is kept wherever it sits,
                        // so both readers below already stand behind `!preserve`.
                        // (…where no CONTENT is on the line: an inline box's edges alone leave it at its start — the
                        // oracle's `!lineHasContent`, and what `text_intrinsic` assumes.)
                        let at_line_start = !preserve
                            && (!line_has_content || pending_space.is_some_and(|p| p.sep));
                        // …and `body` is the oracle's string test: a run that is non-empty but zero-advance
                        // (a U+200B) is still a body, and still asks the question.
                        let has_body = if preserve {
                            end > 0
                        } else {
                            text[..end].iter().any(|&u| !is_ws_u16(u))
                        };
                        let pending_w = pending_space.map_or(0.0, |p| p.w);
                        let ow: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
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
                            let stop_at = if floats.borrow().is_empty() { room } else { f64::INFINITY };
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
                            // The collapsed space still pending goes down first, as a HANG: the oracle placed it
                            // where it met it, and that placement ends any run of preserved spaces before it
                            // (`trailingPreserved = 0`) — dropped with the line instead, the wrapped line was
                            // aligned as if they still hung (28.8 where the oracle and Chrome say 19.2).
                            place_pending_space!();
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
                        if has_body {
                            drop_below_floats!(unit + ow);
                        }
                        // …and only now does the kept leading space go down (the oracle's `collapseRun` put it
                        // inside the body, so it rides the line the body landed on).
                        if lead_space {
                            // …after the open edges, which the oracle's body placement puts down first (`placeOnLine`
                            // flushes before it places), and as CONTENT: it is part of the body.
                            settle_pending_oofs!();
                            flush_open_edges!();
                            // (…the body's first piece, and a separator of it.)
                            flush_tail_gaps!();
                            if justifying {
                                tail_gaps.push(band_l(total) + line_x);
                            }
                            body_started = true;
                            let (at, to) = advance!(space_w);
                            drop_hangs!(false);
                            note_open!(at, to, false);
                            line_asc = line_asc.max(run.asc);
                            line_desc = line_desc.max(run.line_height - run.asc);
                            line_has_content = true;
                            line_placed = true;
                            hang = 0.0;
                            hang_gap = None;
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
                                        // (…after a collapsed space still pending, which the oracle placed where
                                        // it met it — as at a `<br>`.)
                                        place_pending_space!();
                                        flush_each_open_edge!();   // …DIRECT, as the oracle's `i > 0` arm is
                                        break_line!(); // newline → forced break
                                        body_started = false; // …and the next segment is a placement of its own
                                        // …and the SEGMENT it opens drops below a float as one unit, exactly
                                        // as the first did: the oracle runs `retakeBand(runW + …)` for every
                                        // segment, not only the run's first (`segments.forEach`).
                                        if no_wrap && outer_wraps && !floats.borrow().is_empty() {
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
                                                    let at = float_fit_y(&floats.borrow(), fy, seg_w + indent_now.get(), cl, cr, strut_lh);
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
                                        line_placed = true;
                                        // A COLLAPSED space still waiting from an earlier run is placed first —
                                        // the oracle placed it where it met it, and a preserved space is a
                                        // placement like any other, so it does not swallow the one before it.
                                        // BEFORE the open edges, which went down after it there: the gap it
                                        // leaves and the edge's fragment both start where the space ends.
                                        if let Some(ps) = pending_space.take() {
                                            let (w, a, d) = (ps.w, ps.asc, ps.desc);
                                            if ps.sep && !ps.placed {
                                                note_gap!(band_l(total) + line_x); // (a placed one noted it)
                                            }
                                            line_x += w;
                                            line_asc = line_asc.max(a);
                                            line_desc = line_desc.max(d);
                                            if ps.sep {
                                                // …a REAL collapsed space ENDS the run of preserved ones before
                                                // it: the oracle places it with `hangs`, whose `!edge` arm
                                                // zeroes `trailingPreserved` before `placePreservedSpace`
                                                // re-seeds it. The zero-width marker is only an opportunity and
                                                // ends nothing — and "real" is a question about what the space
                                                // IS, not about what it measures, the same one the gap above
                                                // asks. (Here the two engines then agree on a figure CHROME
                                                // does not share: the oracle zeroes `trailingPreserved` on any
                                                // collapsible-space placement and Chrome does not, so a
                                                // cancelled separator between two `pre-wrap` runs is 132.4 in
                                                // both against Chrome's 151.578. Recorded, not fixed here.)
                                                hang_pre = 0.0;
                                            }
                                        }
                                        flush_open_edges!();
                                        // The separators an earlier non-wrapping run ENDED in become gaps where
                                        // THIS run is placed WHOLE — the oracle's `placeOnLine` for a `pre` run is
                                        // a content placement, which flushes the tail it follows — and stay held
                                        // past a wrapping run's preserved spaces, which are white space and not
                                        // content (`placePreservedSpace`).
                                        if no_wrap && !body_started {
                                            flush_tail_gaps!();
                                            body_started = true;
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
                                        // …a justification gap of its own — held back while the run is placed
                                        // WHOLE, where the separators it ENDS in are the line's end until
                                        // something follows them (`tail_gaps`).
                                        if justifying {
                                            if no_wrap {
                                                tail_gaps.push(band_l(total) + line_x);
                                            } else {
                                                line_gaps.push(band_l(total) + line_x);
                                            }
                                        }
                                        let (at, to) = advance!(adv);
                                        drop_hangs!(false);
                                        note_open!(at, to, false);
                                        hang = 0.0;
                                        hang_gap = None;              // …and it is not a COLLAPSED hang any more
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
                                        pending_space = Some(PendingSpace { w: 0.0, asc: run.asc, desc: run.line_height - run.asc, breaks: !no_wrap, sep: false, placed: false });
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
                            // …and whether any of it comes BEFORE the first newline: that much is a collapsible
                            // space on the line the newline ends, which the oracle places there like any other
                            // (its first `\n`-segment) and the break then eats — so an empty inline box holding
                            // ` \n ` has a line record there, and hangs from that line's baseline.
                            let spaces_first = !break_nl || text[i] != 0x0A;
                            while i < text.len() && is_ws_u16(text[i]) {
                                if text[i] == 0x0A {
                                    nl += 1;
                                }
                                i += 1;
                            }
                            if spaces_first {
                                collapse_space!();
                            }
                            if break_nl && nl > 0 {
                                // …and a `pre-line` newline ends its line the same way a preserved one does,
                                // with the open edges on it. This used to be asked only of a run carrying REAL
                                // content, because a whitespace-ONLY one took the oracle's collapsed branch and
                                // never reached `placeTextRun` at all — a divergence native recorded here
                                // rather than bending to, since Chrome breaks and the oracle did not. The
                                // oracle routes a `pre-line` run holding a NEWLINE through the breaker now, so
                                // the two sides agree and the flush is unconditional again. It has to be: a
                                // marker waiting on an open edge settled on the line AFTER the break otherwise
                                // (`<span style="padding-left:6px"><i abspos></i>\n<span>y</span></span>` put
                                // it at y 22 where Chrome and the oracle say 0).
                                settle_pending_oofs!();
                                place_pending_space!();
                                flush_each_open_edge!();   // …DIRECT, as the oracle's `i > 0` arm is
                                for _ in 0..nl {
                                    break_line!();
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
                        let (space_before, sw, sasc, sdesc, space_breaks, space_sep, space_placed) = match pending_space.take() {
                            Some(p) => (true, p.w, p.asc, p.desc, p.breaks, p.sep, p.placed),
                            None => (false, 0.0, 0.0, 0.0, false, false, false),
                        };
                        let inside_body = std::mem::take(&mut body_space) && space_sep && !space_placed;
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
                        let space_on_line = space_before && line_placed;
                        if space_on_line {
                            // …an OPPORTUNITY is no gap: what is asked is what the pending space IS, not what it
                            // measures (see `PendingSpace`). The two coincide at every producer today — nothing
                            // queues a non-zero opportunity — which is exactly why reading the width looked like
                            // asking the question. (Hanging after preserved ones, under pre-wrap: all of them hang.)
                            // …and one INSIDE a run placed whole is a separator of its body, held like the others.
                            if inside_body {
                                // (…the body's FIRST piece where it leads it: what was held back before the run is
                                // flushed then, and not with the space's own gap.)
                                if !body_started {
                                    flush_tail_gaps!();
                                    body_started = true;
                                }
                                if justifying {
                                    tail_gaps.push(band_l(total) + line_x);
                                }
                                hang_space!(false, sw);
                            } else {
                                hang_space!(space_sep && !space_placed, sw);
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
                                    let ow_now: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
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
                                    drop_below_floats!(cw + ow_now);
                                    settle_pending_oofs!();
                                    flush_open_edges!();
                                    flush_tail_gaps!();
                                    note_nbsp_gaps!(run, &text[u..u + ulen], band_l(total) + line_x);
                                    let (at, to) = advance!(cw);
                                    drop_hangs!(false);
                                    note_open!(at, to, false);
                                    hang = 0.0;
                                    hang_gap = None;
                                    hang_pre = 0.0;
                                    line_asc = line_asc.max(run.asc);
                                    line_desc = line_desc.max(run.line_height - run.asc);
                                    line_has_content = true;
                                    line_placed = true;
                                    first = false;
                                    u += ulen;
                                }
                            }
                            atomic_break = false; // consumed the after-atomic break opportunity
                            ends_open = ends_with_break(text[i - 1]); // …and this word may leave one behind
                        } else {
                            let ow: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
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
                            if !no_wrap {
                                drop_below_floats!(width + ow);
                            }
                            // Flush the still-open edges onto this line (once), then place the word.
                            settle_pending_oofs!();
                            flush_open_edges!();
                            // (…a later piece of a run placed whole flushes at its first non-separator, below.)
                            if !(no_wrap && body_started) {
                                flush_tail_gaps!();
                            }
                            note_nbsp_gaps!(run, &text[start..i], band_l(total) + line_x);
                            body_started = true;
                            let (at, to) = advance!(width);
                            drop_hangs!(false);
                            note_open!(at, to, false);
                            hang = 0.0;
                            hang_gap = None;
                            hang_pre = 0.0;
                            line_asc = line_asc.max(run.asc);
                            line_desc = line_desc.max(run.line_height - run.asc);
                            line_has_content = true;
                            line_placed = true;
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
                let (space_before, sw, sasc, sdesc, space_breaks, space_sep, space_placed) = match pending_space.take() {
                    Some(p) => (true, p.w, p.asc, p.desc, p.breaks, p.sep, p.placed),
                    None => (false, 0.0, 0.0, 0.0, false, false, false),
                };
                let space_is_hard = space_before && !space_breaks;
                let space_on_line = space_before && line_placed;
                let mut broke = false;
                if space_on_line {
                    hang_space!(space_sep && !space_placed, sw); // …an OPPORTUNITY is no gap (see `PendingSpace`)
                }
                let ow: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
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
                // An ATOMIC drops the line below a float here WHATEVER the block's mode — including a `nowrap` /
                // `pre` block, whose TEXT arm above never drops (`!no_wrap`). So does the oracle's `placeOnLine`
                // (`retakeBand(w + pending)`, no mode test), and the two agree. Chrome does not: it never drops a
                // no-wrap line below a float, so a `nowrap` block with a 5px inline-block beside a 90px float of 80
                // is 60 tall there and 82 in both engines. SHARED, so recorded rather than fixed. (This comment
                // said the opposite until 2026-09-23 — "a nowrap line is not dropped below a float" — which is
                // true of the text arm and was never true here.)
                if may_break_here {
                    drop_below_floats!(width + ow);
                }
                settle_pending_oofs!();
                flush_open_edges!();
                // …and the separators a preceding non-wrapping run ENDED in are gaps now that this box follows
                // them, so they are flushed BEFORE the count is taken: they precede it in flow order.
                flush_tail_gaps!();
                let (at, to) = advance!(width);
                line_atomics.push((ri, at, line_gaps.len())); // its margin box starts here on this line
                line_x += run.size; // …and a grown flex container's growth moves the pen, not the break
                // (…which the boxes around it do not hold: the oracle notes the reserved width and grows the
                // container afterwards, moving only the pen.)
                drop_hangs!(false);
                note_open!(at, to, false);
                hang = 0.0;
                hang_gap = None;
                hang_pre = 0.0;
                // A LINE-RELATIVE box gives the line no ascent and no descent — it is placed against an edge
                // the line does not have yet, so all it can say is how tall the line has to be.
                if run.line_mode != 0 {
                    line_outer_min = line_outer_min.max(run.line_height);
                } else {
                    line_asc = line_asc.max(run.asc);
                    line_desc = line_desc.max(run.line_height - run.asc);
                }
                line_has_content = true;
                line_placed = true;
                atomic_break = true; // a break opportunity follows this atomic
            }
            RUN_OOF => {
                // §4.1: it neither sizes nor shifts the line. `font` carries its record index (the walk's
                // marker), and what is wanted is only WHERE the flow had reached: this x on this line. A line
                // that holds nothing else is still a line the flow reached — `line_placed` is untouched,
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
                // The inline box it sits DIRECTLY in — the innermost one open, since every inline opens one — if that
                // box has an opening edge of its own still unplaced, and the edges around it have not been placed —
                // asked of their SUM, as the flush is, so a pair that CANCELS is never "unplaced" to wait for — has
                // not told the flow where it reaches: the edge goes down when the box's first content does, which
                // may be a later line than this one.
                // (The SUM is `placeOnLine`'s question, never the close's — see the two macros above.)
                // Wait for it, keeping the cursor as the fallback for an edge that never lands. An edge further
                // OUT is not waited on — the oracle asks only `openInlines[openInlines.length - 1]`, so a plain
                // inner inline reads the cursor however edged the boxes around it are.
                let unplaced: f64 = open.iter().filter(|o| !o.placed).map(|o| o.w).sum();
                if unplaced != 0.0 && open.last().is_some_and(|o| o.w != 0.0 && !o.placed) {
                    // (`open.len()` is its own inline's depth.)
                    let pending_w = pending_space.map_or(0.0, |p| p.w);
                    pending_oofs.push((ci, rx, ry, open.len(), line_x + pending_w, line_no));
                } else if rtl {
                    oofs.push((ci, content_w + rx, total + ry));
                } else {
                    let pending_w = pending_space.map_or(0.0, |p| p.w);
                    line_oofs.push((ci, band_l(total) + line_x + pending_w, rx, total + ry));
                }
            }
            RUN_FLOAT => {
                // Placed as block flow places a float (`place_float`), from the top of the line the flow is on —
                // the oracle's `placeFloat(…, flowY)` — beside the floats already there, whatever this line holds
                // so far. The line then takes the band the float leaves (`retakeBand`), which moves only its
                // LEFT edge and never the content already on it: the pen stays where it stood, so in the band's
                // frame it steps back by however far the band's left edge moved. (Chrome instead moves the
                // placed content past a left float, or drops a float that does not fit beside it to the next
                // line; both engines share this model.)
                let f = inline_floats.get(next_float)?;
                next_float += 1;
                let left_before = raw_band_l(total);
                let (x, y) = place_float(&mut floats.borrow_mut(), f, top + total, cl, cr);
                placed_floats.push((run.font as usize, x, y));
                if line_placed {
                    let shift = raw_band_l(total) - left_before;
                    line_x -= shift;
                    // …and a marker waiting on an opening edge stood at a cursor in that same frame, so it steps
                    // back with the pen (one recorded on an earlier line is not read against this band at all).
                    for p in pending_oofs.iter_mut() {
                        if p.5 == line_no {
                            p.4 -= shift;
                        }
                    }
                }
            }
            RUN_WBR => {
                // …an inline box of its own to the oracle (`placeInlineBox`), opened and closed where the flow stands
                // with nothing in it: an EMPTY fragment there.
                frags.push(frag_here!(run.font as usize));
                line_empties.push(frags.len() - 1);
                // `<wbr>`: a zero-width soft-wrap opportunity — exactly the oracle's `barrier = null`, the same
                // thing it sets after an atomic inline. So carry it on `atomic_break` (the after-atomic break
                // flag) rather than the `pending_space` slot: the next box may break before it, yet a collapsible
                // space that immediately FOLLOWS still installs its own advance (a phantom width-0 pending space
                // would suppress that space's width). Under `nowrap` the break-before tests ignore the flag.
                atomic_break = true;
                // …and it OVERWRITES what stood there, a non-wrapping run's hard space included: the oracle
                // keeps ONE `barrier` and a `<wbr>` sets it to `null` outright. Without this the atomic arm's
                // `!space_is_hard` veto cancelled the opportunity the `<wbr>` had just installed.
                if let Some(ps) = pending_space {
                    pending_space = Some(PendingSpace { breaks: true, ..ps });
                }
            }
            _ => return None, // unknown run kind
        }
    }

    if line_placed {
        close_line!(false, false); // close the final line (a trailing <br>'s fresh empty line is NOT closed)
    }
    // An opening edge that never landed (its inline closed holding nothing the flow placed) leaves the cursor
    // read at the marker standing, which is what `pendingStatic` falls back to when the inline has no fragment.
    // Believed UNREACHABLE, though no longer for the reason it used to be: the walk admits an edged inline
    // holding nothing at all now, and what makes this dead is the CLOSE — an inline with a non-zero opening
    // edge settles its waiting markers and flushes on the way out, so a marker can only still be pending if
    // the edge it waited on was zero, and the push condition (the innermost open box's edge `o.w != 0.0`) never
    // records one of those. Kept because the alternative to a wrong answer here is no answer at all —
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
    for (ci, x, rx, y) in line_oofs.drain(..) {
        oofs.push((ci, x + rx, y));
    }
    // The inline boxes' fragments, as the oracle's `settleInlineBoxes` makes them: a rect per line the box's content
    // reached — from its leftmost extent to the furthest of what it placed and what still hangs there, hung from the
    // line's baseline by the box's own ascent and grown by its vertical edges — skipping a line whose only
    // placement a break ate; an EMPTY box a zero-width rect on the first line it reached, or where it opened (on
    // the line, if that line became one), and then its relative offset.
    let mut inline_frags: Vec<(usize, [f64; 4])> = Vec::new();
    for f in &frags {
        let ib = f.ib;
        let h = ib.own_h + ib.top + ib.bottom;
        let top_of = |l: &FragLine| l.top + l.asc - ib.own_asc - ib.top;
        let at = inline_frags.len();
        for l in &f.lines {
            let right = l.max_right.max(l.hang_right);
            if right == f64::NEG_INFINITY {
                continue;
            }
            inline_frags.push((f.idx, [l.min_x, top_of(l), (right - l.min_x).max(0.0), h]));
        }
        if inline_frags.len() == at {
            let r = match f.lines.first() {
                Some(l) => [l.min_x, top_of(l), 0.0, h],
                None if f.on_line => [f.open_x, f.open_top - ib.top, 0.0, h],
                None => [f.open_x, f.open_top, 0.0, 0.0],
            };
            inline_frags.push((f.idx, r));
        }
        for piece in &mut inline_frags[at..] {
            piece.1[0] += ib.rel_x;
            piece.1[1] += ib.rel_y;
        }
    }
    Some(LineLayout { height: total, first: first_line, last: last_line, atomics, oofs, floats: placed_floats, frags: inline_frags })
}
// Where one ATOMIC run landed on its line, in the frame the text arm places boxes in. `x` is its margin box
// from the content edge, with its float band and the line's alignment already applied. The three line figures
// are the LINE's, not the box's: a baseline-aligned box needs `line_asc`, one hanging from a line EDGE
// (`vertical-align: top` / `bottom`) needs `line_h` instead, and neither can be recovered afterwards because
// the line is gone by then.
struct PlacedAtomic {
    run: usize,
    x: f64,
    line_top: f64,
    line_asc: f64,
    line_h: f64,
}
// What `line_layout` lays out: the line count, the content height, and the first / last line as (top, ascent)
// within the content box — the baselines a box hands its container.
struct LineLayout {
    height: f64,
    first: Option<(f64, f64)>,
    last: Option<(f64, f64)>,
    // Where each ATOMIC run landed — the text arm drops a natively laid-out atomic onto its line from these.
    atomics: Vec<PlacedAtomic>,
    // Where each OUT-OF-FLOW marker's flow position fell: (record index, x from the content edge, line top).
    // `place_out_of_flow` reads it as the static corner, exactly as block flow's cursor is read.
    oofs: Vec<(usize, f64, f64)>,
    // Where each inline FLOAT landed: (record index, border-box x, border-box y) in the float context's frame.
    floats: Vec<(usize, f64, f64)>,
    // Each inline box's fragments: (inline index, [x, y, w, h] from the content box's origin).
    frags: Vec<(usize, [f64; 4])>,
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

// A float's laid-out box, as placing it needs it: its side and `clear`, its border box and its margins.
struct FloatBox {
    side: u8,
    clear: u8,
    w: f64,
    h: f64,
    ml: f64,
    mr: f64,
    mt: f64,
    mb: f64,
}
// Lay a float's subtree out (in a fresh context — a float starts its own BFC) in `content_w` of room. §10.3.5: its
// AUTO width SHRINKS TO FIT where a block's fills — its min-content widened to the room its containing block leaves
// it (its own margins off, as the oracle's `avail`), capped at its max-content, and then through `used_width` for
// its min/max and the border-box floor like any declared one. That is `block_child_width`'s own `fit-content` arm,
// and an intrinsic-size KEYWORD on a float wants the same treatment as on any other box, so the one helper answers
// both — reading only `is_auto` would send `width: max-content` down the fit-content path, which is the same answer
// only while `intrinsic_widths_of` happens to PIN the keyword's figure (it returns early for a table before that
// pin). The walk marks such a float a MEASURED subtree, so a measure that fails is that gate having a hole rather
// than a shape to defer.
#[allow(clippy::too_many_arguments)]
fn measure_float(
    c: usize,
    content_w: f64,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
    boxes: &mut [Box],
    failed: &std::cell::Cell<bool>,
) -> FloatBox {
    let cn = inputs[c].get();
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
    FloatBox {
        side: cn.float_kind,
        clear: cn.clear,
        w: boxes[c].w,
        h: boxes[c].h,
        ml: Input::m(cn.ml),
        mr: Input::m(cn.mr),
        mt: Input::m(cn.mt),
        mb: Input::m(cn.mb),
    }
}
// Place a float whose MARGIN box hangs from `top0` (§9.5.1): below the floats it clears, then at the first y where
// the band is wide enough for it, against that band's edge on its side. The rectangle joins the context and the
// box's border-box origin comes back. Its own margins never collapse with anything (§8.3.1).
fn place_float(items: &mut Vec<FloatItem>, f: &FloatBox, top0: f64, cl: f64, cr: f64) -> (f64, f64) {
    let outer = f.w + f.ml + f.mr;
    let outer_h = f.h + f.mt + f.mb;
    let mut mtop = top0;
    if f.clear != 0 {
        mtop = mtop.max(clearance_y(items, mtop, f.clear));
    }
    mtop = float_fit_y(items, mtop, outer, cl, cr, outer_h);
    let top = mtop + f.mt;
    let (band_l, band_r) = float_band(items, mtop, outer_h, cl, cr);
    let x = if f.side == FLOAT_LEFT { band_l + f.ml } else { band_r - outer + f.ml };
    items.push(FloatItem { side: f.side, left: x - f.ml, right: x + f.w + f.mr, top: mtop, bottom: top + f.h + f.mb });
    (x, top)
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
    // A replaced box that LAYS OUT CHILDREN (a list box showing rows): its own box is the control's chrome, from
    // the intrinsic data (`replaced_box` — this element's width / height / min / max and box-sizing applied to
    // it), and everything below lays its rows out INSIDE that box, in whatever formatting context the control
    // declares. The box is handed on as the width and the IMPOSED height, so the record keeps its declarations:
    // writing the resolved figures back turned the box into its own input, and a second measure of the same node
    // (a flex stretch, a float's two passes) then read a percentage width as a border box with no clamps left.
    let (w, imposed_h) = if inputs[i].get().lays_out_children {
        replaced_box(&inputs[i].get().with_imposed_height(imposed_h), w)
    } else {
        (w, imposed_h)
    };
    let n = inputs[i].get().with_imposed_height(imposed_h);
    boxes[i].clamped_h = false; // (set by the arms below, where an auto height's clamp moves it)
    let content_top_rel = n.bt + n.pt;
    let content_w = n.content_w(w);
    // This box is its in-flow children's containing block: their percentage sizes resolve against its content
    // width and — where it is definite — its content height (a flex COLUMN's main size, floor included), which is
    // what the oracle hands `usedSize` for them. Resolved afresh on every measure, so a box measured again at
    // another width or under an imposed height hands them the box it has now.
    // …with ONE exception, and it is a table cell's first pass (§17.5.3). A cell holding a percentage-height
    // descendant is laid out TWICE — first to SIZE it, with those descendants treated as AUTO so they cannot
    // inflate the cell that is supposed to contain them, and again at the final ROW height, which is the only
    // figure they may resolve against. The cell's own declared height is a MINIMUM, not a basis, so it must not
    // become one here. `measure_table` marks the second pass by IMPOSING that row height: nothing else ever
    // imposes one on a cell, so the argument is the whole test and no field is needed for it.
    let cell_first_pass = n.cell_pct_h_child && is_auto(imposed_h);
    let pct_h_basis = if n.anon_group {
        n.group_pct_h
    } else if cell_first_pass {
        f64::NAN
    } else if n.display == DISPLAY_FLEX && !n.flex_main_is_x {
        n.column_main()
    } else {
        n.definite_content_h().unwrap_or(f64::NAN)
    };
    for &c in &children[i] {
        let k = inputs[c].get();
        if k.anon_group {
            inputs[c].set(Input { group_pct_h: pct_h_basis, ..k });
        } else if k.has_percent_sizes() && k.out_of_flow == 0 {
            inputs[c].set(k.with_percent_sizes(content_w, pct_h_basis));
        }
    }

    // A REPLACED leaf: its box comes from its intrinsic size (`replaced_box`) — the width the caller resolved
    // through `used_width` (or a flex size), the height derived here; no children, no baseline of its own
    // (a container synthesises its bottom edge), margins that never adjoin.
    if n.replaced && !n.lays_out_children {
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
            // A FLOAT written among the runs is measured up front — its box does not depend on where it lands —
            // and placed by the lines into this block's float context. A block that establishes its own
            // context CONTAINS those floats (its content reaches down to their bottom) and they go no further;
            // otherwise they stay in the context the siblings after this block route around.
            let inline_floats: Vec<FloatBox> = local
                .iter()
                .filter(|r| r.kind == RUN_FLOAT)
                .map(|r| measure_float(r.font as usize, content_w, inputs, runs, run_texts, grids, children, boxes, failed))
                .collect();
            let floats_before = fc.items.len();
            match line_layout(local, &run_texts[rs..re], n.strut_lh, n.strut_asc, content_w, &mut fc.items, &inline_floats, cl, cr, bfc_top, LineStyle {ws_mode: n.ws_mode, align: n.text_align, rtl: n.from_right(), indent: (clamp_affine(n.indent_px + n.indent_frac * content_w, n.indent_lo, n.indent_hi, content_w), n.indent_hanging, n.indent_each_line, n.indent_spent)}) {
                Some(ll) => {
                    // The inline boxes' fragments, into this box's border-box frame (`place` moves them on).
                    store_frags(i, ll.frags.iter().map(|&(idx, r)| [idx as f64, n.bl + n.pl + r[0], content_top_rel + r[1], r[2], r[3]]).collect());
                    boxes[i].first_baseline = ll.first.map(|(top, asc)| content_top_rel + top + asc);
                    boxes[i].last_baseline = ll.last.map(|(top, asc)| content_top_rel + top + asc);
                    boxes[i].inline_block_baseline = boxes[i].last_baseline;
                    // Each native atomic drops from its line's top to where its own baseline meets the line's.
                    for a in ll.atomics {
                        let r = local[a.run];
                        if r.font < 0 {
                            continue;
                        }
                        let c = r.font as usize;
                        let k = inputs[c].get();
                        // …by its own baseline, or — `vertical-align: top` / `bottom` — against the edge of the
                        // line box the close settled. The oracle's `dy` in `forceBreak`, exactly.
                        let dy = match r.line_mode {
                            1 => 0.0,
                            2 => a.line_h - r.line_height,
                            _ => a.line_asc - r.asc,
                        };
                        boxes[c].x = n.bl + n.pl + a.x + Input::m(k.ml);
                        boxes[c].y = content_top_rel + a.line_top + dy + Input::m(k.mt);
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
                    for (ci, x, y) in ll.floats {
                        boxes[ci].x = x - bfc_x;
                        boxes[ci].y = y - bfc_y;
                    }
                    if n.starts_bfc && fc.items.len() > floats_before {
                        let own = fc.items.split_off(floats_before);
                        ll.height.max(floats_bottom(&own) - bfc_top)
                    } else {
                        ll.height
                    }
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
        // (A table CELL's block-axis min/max are none on the record — Chrome leaves a `min-height: 40px` cell at its
        // 20px line, and a `max-height: 5px` one uncapped: its height is a floor and its row decides the rest.)
        let flowed = box_h;
        let box_h = clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0);
        boxes[i].nid = n.nid;
        boxes[i].w = w;
        boxes[i].h = box_h;
        boxes[i].clamped_h = is_auto(n.height) && box_h != flowed;
        boxes[i].natural_h = Some(flow_h);
        boxes[i].auto_height = is_auto(n.height);
        let top = CMargin::of(Input::m(n.mt));
        // A text block whose stream put NOTHING on a line — only markers, an out-of-flow box's or a float's — holds
        // a line of nothing, which is zero-height and separates no margins (§9.4.2): with no edges or height of
        // its own it collapses THROUGH like an empty block (Chrome: a margined `<div>` holding only
        // `<span><abs/></span>` is 0 tall and its margins join). Otherwise its margins are its own.
        if boxes[i].first_baseline.is_none() && box_h == 0.0 && !n.starts_bfc && n.height_adjoins && n.minh_adjoins
            && n.bt == 0.0 && n.bb == 0.0 && n.pt == 0.0 && n.pb == 0.0
        {
            let mut run = top;
            run.merge(CMargin::of(Input::m(n.mb)));
            return MInfo { top: run, top_only: top, bottom: run, collapse_through: true };
        }
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
            // its STATIC position here — where the flow has reached, the MARGIN still open above it included (the
            // content's right edge for an rtl flow) — and is sized and placed by `place_out_of_flow` once every
            // box is final. The margin counts because the static position is where the box WOULD have sat in
            // flow, and a box in flow there sits past it: the same `cursor + pending` a FLOAT is placed at a
            // few lines up. Measured: `<p>block</p><div abspos></div><p>tail</p>` puts the box at 50 in
            // Chrome and at 34 without this, the `<p>`'s 16px bottom margin missing.
            // (Its OWN margins are still dropped on this path — §10.6.4's static position is the MARGIN
            // edge, and Chrome puts a `margin-top: 7px; margin-left: 3px` box at 3/57 where both engines
            // say 0/50. The inset path applies them correctly. Shared, so recorded rather than fixed here.)
            // Replayed, its subtree is laid out at its pushed border box (in a fresh context — it
            // establishes a BFC) and its box reset to this block's origin; `place` then positions it by rel_x/rel_y
            // alone (el._lb − container._lb). Neither touches the cursor / margin / has_child state.
            if cn.native_oof() {
                // That cursor is a LINE cursor: it starts in the band a float leaves at this y — asked over a
                // LINE BOX's height, as `line_layout` asks it and as `retakeBand` does, so a float whose band
                // starts just below the cursor is not missed — and it carries the block's FIRST-LINE INDENT
                // until an in-flow child spends it (an out-of-flow box is not a child that does). An rtl flow
                // reads neither: its corner is the content's right edge.
                let at = cursor + pending.value();
                boxes[c].x = if n.from_right() {
                    content_left_rel + content_w
                } else {
                    let indent = if !has_child != n.indent_hanging { clamp_affine(n.indent_px + n.indent_frac * content_w, n.indent_lo, n.indent_hi, content_w) } else { 0.0 };
                    float_band(&ctx.items, at, n.strut_lh, cl, cr).0 + indent
                };
                boxes[c].y = at;
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
            let f = measure_float(c, content_w, inputs, runs, run_texts, grids, children, boxes, failed);
            let (x, y) = place_float(&mut ctx.items, &f, cursor + pending.value(), cl, cr);
            boxes[c].x = x;
            boxes[c].y = y;
            continue; // the flow cursor / first / has_child are untouched
        }
        // A box that starts its own context, placed at `$cy` beside the floats (§9.5): its whole border box goes in
        // the band they leave there, sized to it (an auto width narrows to it, a declared one keeps its size); a box
        // too WIDE for the band drops below the float instead and re-places in the widened band below it.
        macro_rules! place_beside_floats {
            ($cy:expr) => {{
                let cy = $cy;
                let (ml, mr) = (Input::m(cn.ml), Input::m(cn.mr));
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
            }};
        }
        // A DIRECT text-block child coexisting with floats routes its lines around them (§9.5). Its
        // collapsed top is deterministic (a text block's top_only is of(mt), whether or not it collapses
        // through), so it can be placed BEFORE measuring — which the narrowing needs, to know each line's flow
        // position in the owner frame. A CLEARED box and a box that starts its own context are placed by their own rules
        // below; a plain block container falls through to the general path, which lays it out in this
        // context read in its own frame.
        if !ctx.items.is_empty() {
            // A cleared child (§9.5.2) moves DOWN to below the floats it named — its margin collapses as
            // usual, then clearance replaces its position with the float bottom, and it is laid out there in
            // the context like any other child: a plain block meets the floats in its own frame, one that
            // starts its own context avoids them.
            if cn.clear != 0 {
                // Measure FIRST, in an empty context — the general path's probe: only the COLLAPSING top margin
                // (cm.top_only) comes out of it — its own margin joined with any a first descendant folds
                // through its open top edge — which is what the oracle advances the flow by
                // (collapsingTopMargin); the own declared margin alone would drop the descendant's.
                let cm = measure(c, width_in(c, content_w), f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                if cm.collapse_through {
                    // A cleared box that collapses THROUGH — the clearfix `<div style="clear: both">` — does
                    // not advance the flow by a height of its own; the clearance line moves the flow ITSELF
                    // (§8.3.1), from where the last border box ended, and the box sits past the margins above
                    // it there. Its run then stays open past the line for whatever follows. Under an open top
                    // edge one that takes clearance ends the hoisting: its run was never part of this block's
                    // margin (`marginInfo` stops at it), so it opens here and the next child is placed below
                    // it — which is also why a block holding floats and a clearfix is as tall as its floats.
                    let spent = first && top_open;
                    let clear_to = clearance_y(&ctx.items, cursor, cn.clear);
                    // (One that does NOT take clearance keeps hoisting — which says there is no float on the side
                    // it names earlier in this context, so its clearance line cannot be below the flow.)
                    if spent && !cn.takes_clearance && clear_to > cursor {
                        failed.set(true);
                    }
                    cursor = cursor.max(clear_to);
                    let y = (cursor + if spent { 0.0 } else { pending.peek(cm.top_only) }).max(clear_to);
                    let child_w = width_in(c, content_w);
                    let cx = block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, child_w);
                    let mut inner = FloatCtx { items: ctx.items.iter().map(|f| f.shifted(-cx, -y)).collect() };
                    let placed = inner.items.len();
                    let cm2 = measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut inner, 0.0, 0.0);
                    if !cm2.collapse_through || cm2.top.value() != cm.top.value() || boxes[c].w != child_w {
                        failed.set(true);
                    }
                    boxes[c].x = cx;
                    boxes[c].y = y;
                    ctx.items.extend(inner.items[placed..].iter().map(|f| f.shifted(cx, y)));
                    has_child = true;
                    if !spent {
                        pending.merge(cm.top);
                        first = false;
                    } else if cn.takes_clearance {
                        pending = cm.top;
                        first = false;
                    } else {
                        top_m.merge(cm.top);
                    }
                    if cn.takes_clearance {
                        all_children_through = false;
                    }
                    continue;
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
                    // One that starts its own context meets the floats only as the band they leave at the
                    // clearance line: placed there exactly as the BFC arm below places one from the flow. Past
                    // every float that band is the whole content width — the oracle's own `band == null`, auto
                    // margins and legacy alignment included — and the measure above already laid it out in it.
                    if cn.starts_bfc {
                        if y < floats_bottom(&ctx.items) {
                            place_beside_floats!(y);
                            continue;
                        }
                        boxes[c].x =
                            block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, boxes[c].w);
                        boxes[c].y = y;
                        cursor = y + boxes[c].h;
                        pending = cm.bottom;
                        all_children_through = false;
                        has_child = true;
                        first = false;
                        continue;
                    }
                    // A plain block keeps its full width and meets the floats in its own frame at the clearance
                    // line, exactly as the general path below reads the context — whether or not a float on the
                    // side it does not name still reaches that line (§9.5 routes the LINES inside it round one
                    // that does). Past every float it still is not an empty context: a descendant a negative
                    // margin pulls ABOVE the clearance line meets the floats there, and clears them or wraps round
                    // them (the oracle, which lays the box out in the shared context, does both).
                    let child_w = width_in(c, content_w);
                    let cx = block_child_x(&n, &cn, content_left_rel, content_left_rel + content_w, child_w);
                    let mut inner = FloatCtx { items: ctx.items.iter().map(|f| f.shifted(-cx, -y)).collect() };
                    let placed = inner.items.len();
                    let cm2 = measure(c, child_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut inner, 0.0, 0.0);
                    // (The same backstops the general path keeps: a margin the floats changed, or a used width
                    // the measure settled for itself, and the frame the floats were read in is stale.)
                    if cm2.collapse_through || cm2.top_only.value() != cm.top_only.value() || boxes[c].w != child_w {
                        failed.set(true);
                    }
                    boxes[c].x = cx;
                    boxes[c].y = y;
                    ctx.items.extend(inner.items[placed..].iter().map(|f| f.shifted(cx, y)));
                    cursor = y + boxes[c].h;
                    pending = cm2.bottom;
                    all_children_through = false;
                    has_child = true;
                    first = false;
                    continue;
                }
            } else if cn.starts_bfc {
                // A child that ESTABLISHES a BFC does not OVERLAP the floats (§9.5): its whole border box is
                // placed in the band they leave and narrowed to it — the media-object shift, where a float and
                // a `flow-root` sibling read as two columns. The BFC barrier keeps its own top margin from
                // folding a descendant's through, so its collapsed top is deterministic.
                let t_top = CMargin::of(Input::m(cn.mt));
                let cy = if first && top_open {
                    top_m.merge(t_top);
                    content_top_rel
                } else {
                    pending.merge(t_top);
                    cursor + pending.value()
                };
                place_beside_floats!(cy);
                continue;
            } else if cn.display == DISPLAY_TEXT_BLOCK {
                // A DIRECT text-block child routes its lines around the floats. Its collapsed top is
                // deterministic (a text block's top_only is of(mt), whether or not it collapses through), so it
                // can be placed BEFORE measuring — which the narrowing needs, to know each line's owner-frame y.
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
                has_child = true;
                if cm.collapse_through {
                    // (…one that holds no line collapses through, as the general path below places such a
                    // child: its bottom joins the run it sits in, and the flow does not move.)
                    if first && top_open {
                        top_m.merge(cm.bottom);
                    } else {
                        pending.merge(cm.bottom);
                    }
                    continue;
                }
                cursor = cy + boxes[c].h;
                pending = cm.bottom;
                all_children_through = false;
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
        // (…one that takes CLEARANCE ends the hoisting, as the clear arm above says, and holds this block open.)
        let hoisted_through = first && top_open && cm.collapse_through && !cn.takes_clearance;
        if !cm.collapse_through || cn.takes_clearance {
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
            if cm.collapse_through && cn.takes_clearance {
                pending = cm.top;
            } else if cm.collapse_through {
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
    // (A table CELL's block-axis min/max are none on the record — see the text arm.)
    let flowed = box_h;
    let box_h = clamp_min_max(box_h, to_border(n.min_h), to_border(n.max_h)).max(0.0);

    boxes[i].nid = n.nid;
    boxes[i].w = w;
    boxes[i].h = box_h;
    boxes[i].clamped_h = is_auto(n.height) && box_h != flowed;
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
    children[i].iter().all(|&c| { let k = inputs[c].get(); k.out_of_flow != 0 && !k.is_anonymous() })
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
    // Each item's auto-height measure: its height, and whether its own min/max clamp moved it (`Box::clamped_h`).
    let mut measured: Vec<Option<(f64, bool)>> = vec![None; cnt];
    let measure_of = |p: usize, width: &Vec<f64>, measured: &mut Vec<Option<(f64, bool)>>, boxes: &mut [Box]| -> f64 {
        if measured[p].is_none() {
            let c = kids[p];
            measure(c, width[p], MEASURE_AUTO_HEIGHT, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
            measured[p] = Some((boxes[c].h, boxes[c].clamped_h));
        }
        measured[p].unwrap().0
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
    let auto_min_of = |p: usize, width: &Vec<f64>, measured: &mut Vec<Option<(f64, bool)>>, auto_min: &mut Vec<Option<f64>>, boxes: &mut [Box]| -> f64 {
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
            let known = if base_measured[p] { measured[p].map(|m| m.0) } else if is_auto(decl_h[p]) { None } else { Some(decl_h[p]) };
            if known.map_or(true, |kn| base[p] < kn) {
                auto_min_of(p, &width, &mut measured, &mut auto_min, boxes);
            }
        }
    }
    let clamp_with = |floors: &Vec<Option<f64>>, measured: &Vec<Option<(f64, bool)>>, p: usize, size: f64| -> f64 {
        let k = inputs[kids[p]].get();
        let mut out = size;
        if is_auto(k.min_h) {
            let known = if base_measured[p] { measured[p].map(|m| m.0) } else if is_auto(decl_h[p]) { None } else { Some(decl_h[p]) };
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
            // An item that ended up at EXACTLY the height its own measure produced is laid out at that auto
            // height again, definite column or not — which is what the oracle does by REUSING the measuring
            // layout. Imposing the same number instead is not a no-op for every box: a TABLE reads an imposed
            // height as its rows' and stacks its caption on top of it (72 where Chrome and the oracle say 54).
            // …unless its own min/max-height CLAMPED that measure, in a definite column: the oracle imposes the height
            // there and will not reuse a clamped auto layout for it (`reuseSubtree`), so the content is laid out
            // again against the height it was cut to — a `height: 50%` inside a `min-height: 60%` item resolves
            // against the 90 it came to, not auto (Chrome 45).
            let imposed = restretched[p] || !is_auto(decl_h[p]) ||
                          measured[p].map_or(true, |(m, clamped)| m != h || (height_definite && clamped));
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
    let gap = clamp_affine(
        n.flex_main_gap + if n.flex_main_gap_frac != 0.0 && !is_auto(main_basis) { n.flex_main_gap_frac * main_basis } else { 0.0 },
        n.flex_main_gap_lo, n.flex_main_gap_hi,
        if is_auto(main_basis) { 0.0 } else { main_basis });
    let cross_basis = if main_is_x { n.definite_content_h().unwrap_or(0.0) } else { content_w };
    let cross_gap = clamp_affine(n.flex_cross_gap + n.flex_cross_gap_frac * cross_basis,
                                 n.flex_cross_gap_lo, n.flex_cross_gap_hi, cross_basis);
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
        // (…never below the min-height: where the two conflict the minimum wins, CSS 2.2 §10.7 — the oracle's
        // `maxMainHeight`.)
        let min_main = if is_auto(n.min_h) || n.min_h < 0.0 { 0.0 } else { (to_border_y(n.min_h) - edges_y).max(0.0) };
        let cap_main = if is_auto(n.max_h) || n.max_h < 0.0 { f64::NAN } else { (to_border_y(n.max_h) - edges_y).max(0.0).max(min_main) };
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
    // An AUTO-height column's main extent for a run of items `used` tall: a max-height CAPACITY the content overruns
    // (the items overflow it), else the content floored by min-height. Asked PER LINE, as the oracle's column pass
    // asks it (`extent = capped ?? max(used, floor)`): a wrapping column broken against a max-height has as many
    // extents as lines, the box is the TALLEST (`contentExtent`), and each line justifies within its own — where one
    // extent for all the items made the box the capacity (30 where the oracle and Chrome say 20, the tallest line).
    let col_floor = if is_auto(n.min_h) { 0.0 } else { (to_border_y(n.min_h) - edges_y).max(0.0) };
    let col_cap = if is_auto(n.max_h) { f64::INFINITY } else { (to_border_y(n.max_h) - edges_y).max(0.0).max(col_floor) }; // (min wins, §10.7)
    let col_extent = |used: f64| if used > col_cap { col_cap } else { used.max(col_floor) };
    let content_main = if main_is_x {
        content_w
    } else if is_auto(n.height) {
        // A COLUMN's main is its HEIGHT; with the items already sized, the extent they are justified within
        // is a max-height CAPACITY the content overruns (items overflow it), else the content floored by
        // min-height (a min-height the items underflow IS a main size for justify to distribute —
        // `min-h-screen` on a page shell). No min/max → just the stacked items. (A wrapping column with a
        // min/max-height bails in the harness — this is its single line's extent.)
        col_extent(used_main)
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
    // A PUSHED multi-line container takes the ORACLE's lines where its items carry them (`flex_line`): they broke
    // on the hypothetical sizes, which the final boxes here are not.
    let oracle_lines = !n.flex_native && n.flex_wrap && !flow.is_empty()
        && flow.iter().all(|&p| !inputs[kids[p]].get().flex_line.is_nan());
    let lines: Vec<Vec<usize>> = if native_row || native_col {
        native_lines // broken on the hypothetical sizes by flex_row_sizes / flex_column_sizes
    } else if oracle_lines {
        let mut ls: Vec<Vec<usize>> = Vec::new();
        for &p in &flow {
            let li = inputs[kids[p]].get().flex_line as usize;
            while ls.len() <= li {
                ls.push(Vec::new());
            }
            ls[li].push(p);
        }
        ls.retain(|l| !l.is_empty());
        ls
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
        // …and a PUSHED multi-line container's line is the natural cross its items carry (`flex_line_nat`), the
        // oracle's own figure, where one exists: its final boxes cannot say it where the line mixes stretching and
        // fixed items (`align-content: stretch` grew it, and the stretched boxes hold the grow).
        let pushed_nat = if n.flex_native { f64::NAN } else {
            line.iter().map(|&p| inputs[kids[p]].get().flex_line_nat).filter(|v| !v.is_nan()).fold(f64::NAN, f64::max)
        };
        line_cross[li] = if native_col && li < native_line_crosses.len() {
            native_line_crosses[li]
        } else if !pushed_nat.is_nan() {
            pushed_nat
        } else {
            plain.max(fa + fb).max(la + lb)
        };
        line_first_asc[li] = fa;
        line_first_extent[li] = fa + fb;
        line_last_asc[li] = la;
        line_last_extent[li] = la + lb;
    }

    // The container's CROSS content extent + its own box. The cross is a row's height (auto = the stacked
    // lines, else the declared content height) and a column's content width (always definite here).
    let lines_cross_sum: f64 = line_cross.iter().sum::<f64>() + cross_gap * nlines.saturating_sub(1) as f64;
    let mut clamped = false;
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
            let flowed = lines_cross_sum.max(n.anon_cross) + edges_y;
            let bh = clamp_min_max(flowed, to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0);
            clamped = bh != flowed;
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
            // items overflow). A ROW's is `content_main.max(used_main)`; a COLUMN's is asked per LINE — the
            // tallest line's extent or content (`col_extent`), which for one line is that same figure.
            // A bare-text anonymous item floors the box height (a column's MAIN) at its line-height, applied
            // after the items' extent exactly as the oracle's `max(contentExtent, anonymousItemHeight)`.
            let tallest = lines.iter().map(|line| {
                let lm: f64 = line.iter().map(|&p| mo[p]).sum::<f64>() + gap * line.len().saturating_sub(1) as f64;
                col_extent(lm).max(lm)
            }).fold(0.0f64, f64::max);
            let content_ext = if main_is_x { content_main.max(used_main) } else { tallest };
            let flowed = content_ext.max(n.anon_cross) + edges_y;
            let bh = clamp_min_max(flowed, to_border_y(n.min_h), to_border_y(n.max_h)).max(0.0);
            clamped = bh != flowed;
            bh
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
                    // The stretch is the WRAPPER's height, not a declared one: a table stretched to its line holds
                    // its caption inside that (`height_from_outside`), where a main-axis size stacks it on top.
                    inputs[c].set(Input { height_from_outside: true, ..cn });
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
        // (…an auto-height column's line justifies within its OWN extent — see `col_extent`.)
        // (…and so does a PUSHED one whose record carries its final box as a height it never declared — an auto-height
        // flex item's (`item_auto_height`), or one the oracle laid out with no definite height at all
        // (`pushed_h_indefinite`, a wrapping column inside a definite-height column): only a DEFINITE content height
        // is the one extent every line justifies within, the question `definite_content_h` answers.)
        let line_extent = if !main_is_x && n.definite_content_h().is_none() { col_extent(line_main) } else { content_main };
        let free = line_extent - line_main;
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
            let main_pos = if main_reverse { main_start + (line_extent - at - m_size) } else { main_start + at };
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
    boxes[i].clamped_h = clamped;
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
// nlTableSupported declines only what native can't reproduce: a SECOND caption or a nested-table one, a cell
// whose percentage-height content needs a second pass, an empty or interleaved row group, a nested table, a row
// whose cells all span rows (no row height to read), and a HALF-empty table — columns with no rows under them.
// A wholly EMPTY one is in scope: no grid at all, just the table's edges, its declaration and its caption.
// A table's ROW / COLUMN structure, recovered from the record tree the walk emitted (the oracle's `tableGrid`
// resolved the anonymous boxes and the render order): every row in render order with the row GROUP it belongs
// to, the caption (the table's only non-row / non-group child), and the column count: `declared_cols` (the
// oracle's, which a `<col>` / `<colgroup span>` raises past the cells' own reach) or the last column any cell
// reaches, whichever is larger. `None` for a table native can't read (no rows, no columns, a malformed span).
struct TableGrid {
    rows: Vec<usize>,
    row_group: Vec<Option<usize>>,
    // …and its CAPTIONS, in document order: each is stacked above the grid or below it by its own `caption-side`.
    captions: Vec<usize>,
    c_count: usize,
}
fn table_grid(i: usize, inputs: &[Cell<Input>], children: &[Vec<usize>], declared_cols: usize) -> Option<TableGrid> {
    let mut rows: Vec<usize> = Vec::new();
    let mut row_group: Vec<Option<usize>> = Vec::new();
    let mut captions = Vec::new();
    for &ch in &children[i] {
        // An OUT-OF-FLOW child is no part of the table's structure (§9.7) — not a row, not a caption. The walk
        // emits every one of them under the table, whichever table part it was written in.
        if inputs[ch].get().out_of_flow != 0 {
            continue;
        }
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
            _ => captions.push(ch),
        }
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
    // An EMPTY table — no rows AND no columns — is a grid of nothing, which `measure_table` sizes from the
    // table's own edges, its declaration and its caption alone (§17.5.3 still floors that empty region at an
    // imposed height: Chrome makes an empty `height: 100px` table 100 tall). A HALF-empty one is not: columns
    // with no rows under them, or a row with no cells to give it a height, are `nlTableSupported`'s to decline.
    if rows.is_empty() != (c_count == 0) {
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
    Some(TableGrid { rows, row_group, captions, c_count })
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
    for &c in g.rows.first().map_or(&[][..], |&r0| &children[r0][..]) {
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
    let floor = caption_floor(&g.captions, inputs, runs, run_texts, grids, children)?;
    // An intrinsic CONTRIBUTION reads the table's own edges basis-less, like every other box's (the oracle's
    // `tableIntrinsicWidths` uses `edgeInsets(table, null)`).
    Some(table_min_max_with_caption(&n, &g, &cols, floor, n.decl_edges_x))
}
// The border-box width a table's CAPTION requires of it (the oracle's `captionsFloor`): the caption's MARGIN box
// spans the table's border box (§17.4), and what it cannot be squeezed below is its own min-content contribution
// — a declared LENGTH pinning it, a `%` one indefinite while the table's width is still being decided, the
// min/max-width clamping it — plus its horizontal margins. Those are read BASIS-LESS (`decl_margin_x`, an `auto`
// one already 0), because the table's width is what a percentage among them would resolve against and it is the
// figure being decided here; the same margins are resolved against it once it has settled, in `measure_table`.
// The oracle's figure where native cannot measure the caption; the widest of them where there are several (each
// spans the same box); 0 without one.
fn caption_floor(
    captions: &[usize],
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<f64> {
    let mut floor = 0.0f64;
    for &cap in captions {
        floor = floor.max(caption_intrinsic(cap, inputs, runs, run_texts, grids, children)?.0 + inputs[cap].get().decl_margin_x);
    }
    Some(floor)
}
// A caption's min/max-content: native's own measure, or — where the walk could not measure the subtree and
// PARKED it — the oracle's pushed contribution off rec[84..85], exactly as an unmeasurable CELL travels
// (`table_columns` reads the same pair the same way).
fn caption_intrinsic(
    cap: usize,
    inputs: &[Cell<Input>],
    runs: &[Run],
    run_texts: &[Option<Vec<u16>>],
    grids: &[f64],
    children: &[Vec<usize>],
) -> Option<(f64, f64)> {
    let k = inputs[cap].get();
    if is_auto(k.cell_min_content) {
        intrinsic_widths(cap, inputs, runs, run_texts, grids, children)
    } else {
        Some((k.cell_min_content, k.cell_max_content))
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
    let (rows, row_group, captions, c_count) = (&g.rows, &g.row_group, &g.captions, g.c_count);
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
    let cap_floor = match caption_floor(captions, inputs, runs, run_texts, grids, children) {
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
    // The table's own BORDER box is settled here — its columns and spacing decide it, and the rows cannot move
    // it — so the CAPTION, which spans that box, is laid out before the rows: the height it takes is height the
    // rows do NOT get (a table told to be 120 tall holds its caption inside that 120, Chrome and the oracle).
    let sum_col: f64 = col_w.iter().sum();
    let grid_w = sum_col + table_gaps(c_count, sx);
    // With NO columns the tracks say nothing about the width: a populated table's columns have already shared
    // out whatever it was given (so `grid_w` carries it back), while an empty one keeps the width it resolved —
    // its declaration, or the box it was handed — floored by its caption.
    let table_w = if c_count == 0 { border_w.max(cap_floor) } else { (grid_w + n.edges_x()).max(cap_floor) };
    // The caption is a block box laid out in that BORDER box, outside the table's own border+padding (§17.4
    // wrapper box): an auto width fills it (less its own horizontal margins, `resolve_width`), a declared one (a
    // `%` of it) is its own and may overflow it without growing the table, and a `%` height resolves against
    // nothing (Chrome keeps such a caption its content's height, whatever the table's). Its MARGINS resolve
    // against that border box too — the block it spans — which is why the measure comes after `table_w`.
    // …while a RELATIVE caption's percentage offset resolves against the table's own height where the table has one
    // yet — declared or imposed, its BORDER box as the oracle's `box.height || null` has it; `auto` is none. (Chrome
    // resolves against the table's CONTENT height after its min/max — 8.39 for a padded 100px table where both
    // engines say 11.6 — 10% of its border box; shared, pinned in the block spec.)
    let offset_h = if is_auto(n.height) {
        f64::NAN
    } else {
        let h = if n.border_box { n.height } else { n.height + n.edges_y() };
        if h > 0.0 { h } else { f64::NAN }
    };
    for &cap in captions {
        let k = inputs[cap].get().with_percent_sizes(table_w, f64::NAN).with_relative_insets(table_w, offset_h);
        inputs[cap].set(k);
        // Its used width is the oracle's `layoutSize(caption, availW, 0, box.width, null)`, and `usedSize`
        // sizes a box from its own content for ONE reason: an intrinsic-size KEYWORD. Not for a vertical
        // writing mode's auto width, and not for a `<button>` — both fill the wrapper there, where
        // `block_child_width` (every other block-level child's route) would shrink them, so this is that
        // function minus the two arms the oracle does not have rather than a call to it.
        let room = (table_w - Input::m(k.ml) - Input::m(k.mr)).max(0.0);
        let cap_w = if k.width_kw == 0 {
            used_width(&k, room)
        } else {
            match caption_intrinsic(cap, inputs, runs, run_texts, grids, children) {
                Some((imin, imax)) => used_width(&k, keyword_width(k.width_kw, imin, imax, room, k.pct_edges_x())),
                None => return bail(failed),
            }
        };
        measure(cap, cap_w, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
    }
    // What the wrapper stacks is each caption's MARGIN box (the oracle's `layCaption`: `y += mt + height + mb`), the
    // top ones above the grid and the bottom ones below it, each side in document order — so the vertical margins are
    // height the rows do not get, and the LEADING horizontal one insets it from the wrapper's inline-start edge — an
    // `auto` pair centring it, one `auto` pushing it to the other side (§10.3.3), exactly as `block_child_x` places a
    // block child anywhere else.
    let mut caps: Vec<(usize, f64, f64, bool)> = Vec::with_capacity(captions.len()); // (caption, lead, top margin, below)
    let (mut caption_top_h, mut caption_bottom_h) = (0.0f64, 0.0f64);
    for &cap in captions {
        let k = inputs[cap].get();
        let (ml, mr) = (Input::m(k.ml), Input::m(k.mr));
        let from_right = n.rtl != 0;
        let (lm, tm) = if from_right { (mr, ml) } else { (ml, mr) };
        let (lead_auto, trail_auto) = if from_right {
            (k.auto_margins & 2 != 0, k.auto_margins & 1 != 0)
        } else {
            (k.auto_margins & 1 != 0, k.auto_margins & 2 != 0)
        };
        let lead = auto_margin_split(lead_auto, trail_auto, lm, tm, table_w, boxes[cap].w).0;
        let below = k.caption_side == 1;
        let outer = Input::m(k.mt) + boxes[cap].h + Input::m(k.mb);
        if below {
            caption_bottom_h += outer;
        } else {
            caption_top_h += outer;
        }
        caps.push((cap, lead, Input::m(k.mt), below));
    }
    let caption_h = caption_top_h + caption_bottom_h;

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
    // its declared height already a floor (`height_is_floor`) and clamped by the min/max its record carries —
    // floored by what the row itself declared. A cell aligned on the BASELINE contributes differently: the row's
    // baseline is the deepest first-baseline among those cells, each then drops so its own baseline reaches it, and
    // the row must hold the lowest resulting cell bottom — so those are deferred until the row's baseline is known.
    // A cell that SPANS rows sizes none of them on its own: it joins its FIRST row's baseline group, and whatever
    // the rows it covers come up short of grows the LAST one it touches.
    // A PERCENTAGE row height resolves against what the rows share out — the imposed content height less the
    // spacing around and between them — and only when that height is definite; the percentages are taken in
    // RENDER order (header, body, footer — the order the rows arrive in) and cannot overflow the basis (Chrome
    // squeezes a later one into what is left).
    let imposed_h = {
        let to_content = |v: f64| if n.border_box { (v - n.edges_y()).max(0.0) } else { v };
        // A DECLARED height is the ROWS' to share, and the caption stacks on top of it (Chrome: 120 + 18 = 138);
        // one imposed from OUTSIDE is the WRAPPER's, so the caption comes out of it BEFORE this table's own
        // min/max-height — which are the rows' too (Chrome: a table stretched to 100 under `min-height: 150px`
        // gives its rows 150 and comes to 168).
        let declared = if is_auto(n.height) { 0.0 } else { to_content(n.height) };
        let declared = if n.height_from_outside { (declared - caption_h).max(0.0) } else { declared };
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
    // The table (WRAPPER) SELF-sizes from its grid tracks + spacing plus its own edges (`table_w`, settled with
    // the columns above) and stacks the caption with the grid: the `<table>` el._lb is the WRAPPER, a
    // caption-side:top caption offsetting the whole grid down by its height and a bottom one sitting below it.
    let sum_row: f64 = row_h.iter().sum();
    // …and an imposed height with NO rows to share it out still makes the grid region that tall (the
    // distribution above had no target to give it to). It is live for a POPULATED table too, where the rows
    // have already been grown to fill it — to within the ulp the per-row `room * (row_h[i] / weight)` shares
    // come to — and that is fine because the ORACLE floors in exactly the same place and the same way
    // (`layoutTable`: `if (imposedContentH > y - gridTop) y = gridTop + imposedContentH;`). Agreement, not a
    // line that never fires.
    let grid_h = (sum_row + table_gaps(r_count, sy)).max(imposed_h);
    let content_left = n.bl + n.pl;
    let content_top = n.bt + n.pt + caption_top_h;

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
    let (row_x, row_w) = match c_count {
        0 => (content_left, 0.0),
        _ => (col_x[0], col_x[c_count - 1] + col_w[c_count - 1] - col_x[0]),
    };

    boxes[i].nid = n.nid;
    boxes[i].w = table_w;
    boxes[i].h = grid_h + caption_h + n.edges_y();
    boxes[i].auto_height = false;

    // Place the caption's MARGIN box at the table WRAPPER's border box (§17.4) — OUTSIDE the table's own
    // border+padding: a top caption at the wrapper's top edge (the grid is offset DOWN past it, via content_top),
    // a bottom one just below the table's bottom padding+border, each inset by its own top margin. Along the
    // inline axis it sits one leading margin in from the wrapper's inline-start: the left edge in LTR, and — for
    // a caption NARROWER than the wrapper — the right edge in rtl (§10.3.3 balances the leading margin). Its
    // Phase-A subtree follows through `place`.
    let (mut top_y, mut bottom_y) = (0.0, content_top + grid_h + n.pb + n.bb);
    for &(cap, lead, mt, below) in &caps {
        boxes[cap].x = if n.rtl != 0 { boxes[i].w - boxes[cap].w - lead } else { lead };
        let y = if below { &mut bottom_y } else { &mut top_y };
        boxes[cap].y = *y + mt;
        *y += boxes[cap].h + mt + Input::m(inputs[cap].get().mb);
    }

    // Row-group boxes (relative to the table): span their rows across the full row width — and, in the same
    // walk of the table's children, its OUT-OF-FLOW ones (§9.7 / §4.1). The walk gathers every one of those —
    // written in the table, in a row group or in a ROW — under the TABLE record, because that is where the
    // oracle places them all: at the GRID's top-left corner, past a top caption and inside the table's own
    // border+padding (`layoutTable`'s `placeAbsolute(child, pos, content.x, gridTop, ctx)`). None of them
    // advances the flow or sizes a track; `place_out_of_flow` sizes and positions the rest from that corner.
    // (One walk rather than two: a table with bare rows has every row in this list, so a second pass would be
    // an O(rows) scan per layout for a feature almost no table has — block flow gates the same loop behind a
    // bit and the grid folds it into a loop it was running anyway.)
    for &ch in &children[i] {
        let cn = inputs[ch].get();
        if cn.out_of_flow != 0 {
            if cn.native_oof() {
                boxes[ch].x = content_left;
                boxes[ch].y = content_top;
            } else {
                // Replayed: lay the subtree out at its pushed border box; `place` positions it by rel_x/rel_y.
                let cw = resolve_width(&cn, (table_w - n.edges_x()).max(0.0));
                measure(ch, cw, f64::NAN, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
                boxes[ch].x = 0.0;
                boxes[ch].y = 0.0;
            }
            continue;
        }
        if cn.display != DISPLAY_TABLE_ROW_GROUP {
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

    // §17.5.3 PASS 2. A cell is a definite containing block for its percentage-height descendants only when its
    // own height is definite — and they resolve against its USED height, which is the ROW's and is known only
    // now. So such a cell was laid out INDEFINITELY above, with those descendants treated as auto so they could
    // not inflate it, and is laid out again here at the final height (the oracle's `pass2` / `cbox2`).
    //
    // Which cells: one holding a percentage-height descendant (`cell_pct_h_child`, the walk's answer) AND
    // either a definite height of its own or a table height imposed from somewhere — a row that is merely
    // TALLER because a sibling cell is does NOT make it definite, which is why `imposed_h` is asked here and
    // not just `h > content_h`. Its height is then definite if it declared one, or if the row stretched it past
    // its own content; an auto-height cell whose own CONTENT drives the row stays INDEFINITE, and re-laying
    // that one reproduces the first pass exactly — same box, same floor — so native re-measures the definite
    // ones and no others. (The oracle re-lays it anyway; that costs it a second walk of the subtree and
    // changes nothing.)
    for (ri, &r) in rows.iter().enumerate() {
        for &c in &children[r] {
            let k = inputs[c].get();
            if !k.cell_pct_h_child || (is_auto(k.height) && !(imposed_h > 0.0)) {
                continue;
            }
            let h = row_h[ri..ri + k.cell_rowspan].iter().sum::<f64>() + (k.cell_rowspan as f64 - 1.0) * sy;
            let content_h = boxes[c].natural_h.unwrap_or(boxes[c].h);
            if !(h > 0.0) || (is_auto(k.height) && !(h > content_h + 0.01)) {
                continue;
            }
            measure(c, boxes[c].w, h, inputs, runs, run_texts, grids, children, boxes, failed, &mut FloatCtx::new(), 0.0, 0.0);
        }
    }

    // Row boxes (relative to their parent: the group box, else the table) + cell positions (relative to the
    // row). A cell FILLS the rows it spans — that box, not its content's, is what a click has to land in — and
    // its content then sits within it per `vertical-align` (§17.5.3): `baseline` drops it so the cell's own first
    // baseline meets the row's, `middle` / `bottom` take half / all of the slack the row is taller than the
    // content by (the content's NATURAL height, not the floored box — a `middle` cell whose declared height
    // already exceeds its content still centres that content). The box stays at the row top either way, so the
    // shift moves the cell's own children (their subtrees follow through `place`).
    let (mut table_first_base, mut table_last_base): (Option<f64>, Option<f64>) = (None, None);
    // …and the table takes the LAST of its own top-level children that answers — a row group, or a row written
    // outside one — each in the table's coordinates.
    let mut atomic_by_child: Vec<(usize, Option<f64>)> = Vec::new();
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
        let (mut row_first_base, mut row_last_base, mut row_atomic_base): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
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
            // …and the ROW's own baselines, for the TABLE to hand its container. NOT `row_baseline[ri]`, which
            // is the baseline GROUP's figure and exists only for cells that align on it — every default `<td>`
            // computes `vertical-align: inherit`, so a real table's rows have none. The oracle's
            // `boxBaselineOffset` walks the row's CELLS whatever their alignment and takes the first answer.
            //
            // FIRST and LAST are different cells AND different lines inside them, because `baselineCandidates`
            // REVERSES the children at every level of a `last = true` walk: the first is the first cell's FIRST
            // line, the last the last cell's LAST line. An atomic on a line reads the last (`atomicBaselineOffset`
            // asks `last = true`); a flex line and a baseline cell read the first.
            if row_first_base.is_none() {
                if let Some(b) = boxes[c].first_baseline {
                    row_first_base = Some(shift + b);
                }
            }
            if let Some(b) = boxes[c].last_baseline {
                row_last_base = Some(shift + b);
            }
            // …and a THIRD figure, for an atomic: what this CELL hands the row under the atomic rules — its
            // own bottom margin edge if it scrolls, else what its children gave it (a scroll container inside
            // it gives ITS bottom margin edge, a table inside it gives nothing). The oracle reaches all of
            // these through the same cell, because its `inlineBlock` flag carries down the whole recursion.
            if let Some(b) = atomic_baseline_of(c, boxes[c].inline_block_baseline, inputs, boxes) {
                row_atomic_base = Some(shift + b);
            }
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
                shift_frags(c, 0.0, shift);   // …and the inline fragments on the cell's own lines
            }
        }
        table_first_base = table_first_base.or(row_first_base.map(|b| row_top[ri] + b));
        if let Some(b) = row_last_base {
            table_last_base = Some(row_top[ri] + b);
        }
        // …the ROW's own answer, then its GROUP's: each may scroll and mask what is under it, and the row is
        // only a top-level child of the table when it is written outside a group.
        let row_atomic = atomic_baseline_of(r, row_atomic_base, inputs, boxes).map(|b| row_top[ri] + b);
        let child = row_group[ri].unwrap_or(r);
        match atomic_by_child.last_mut() {
            Some(slot) if slot.0 == child => { if row_atomic.is_some() { slot.1 = row_atomic; } }
            _ => atomic_by_child.push((child, row_atomic))
        }
    }

    // A table's OWN baselines, offset into its border box — read by a flex line, a baseline-aligned cell and
    // an `inline-table` on a line. A table with no row that answers has none, and hangs from its bottom margin
    // edge. RECORDED, not fixed (`conformance は後回し`): Chrome takes an inline-table's baseline from its
    // FIRST row and asks a CELL for its FIRST line whatever the direction, so the first / last split below is
    // the oracle's rule rather than the specs' (CSS 2.1 §10.8.1 / §17.5.4); and for a row whose cells are not
    // baseline-aligned Chrome falls back to the bottom of that row's cell CONTENT box, where both engines take
    // a cell's text baseline — a plain `<table>` inline-table is line 24 / baseline 17 here, 25 / 21 in Chrome.
    // A SCROLLING inline-table is the same rule again: both engines hang it from its bottom margin edge
    // (line 24 / baseline 20) where Chrome still reads its first row's first line (20 / 14).
    boxes[i].first_baseline = table_first_base;
    boxes[i].last_baseline = table_last_base;
    boxes[i].inline_block_baseline = atomic_by_child
        .iter()
        .filter_map(|&(child, base)| {
            let inner = base.map(|b| b - boxes[child].y);
            atomic_baseline_of(child, inner, inputs, boxes).map(|b| boxes[child].y + b)
        })
        .last();

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
    // …the CONSTANT term beside each side's fraction (slots 7 and 8), for a linear `calc()` track:
    // `calc(25% + 10px)` is `frac * content_w + px`. 0 for every other kind.
    base_px: f64,
    limit_px: f64,
}
// …9 since 2026-09-23: each side carries the CONSTANT term beside its fraction, so a `calc(25% + 10px)`
// track is `frac * content_w + px`. A plain percentage sends 0 there.
const GRID_TRACK_STRIDE: usize = 9;
// A grid's header in `grids`: the number of track specs that follow, column gap (px, fraction), row gap (px,
// fraction), declared row height, and the `auto-fill` / `auto-fit` repeat inside those specs — where its ONE
// marshalled copy starts, how long it is, and its kind (1 fill, 2 fit; -1 / 0 / 0 when there is none).
// …13 since 2026-09-22: each gap carries its clamped-affine BOUNDS (lo/hi) beside its `px + frac` pair, so a
// `gap: min(10%, 20px)` is a figure this computes rather than one it has to be handed resolved.
// …17 since the bounds became affine PAIRS (`min(10%, 20%)` is one line capped by another).
const GRID_HEADER: usize = 17;
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
            base_px: grids[o + 7],
            limit_px: grids[o + 8],
        }
    }
    fn needs_content(&self) -> bool {
        !matches!(self.base_kind, 0 | 4) || !matches!(self.limit_kind, 0 | 4)
    }
}
// One side of a track in px, given the column's (min, max) content contribution — the oracle's `resolveSideSpec` —
// and the grid's content width, which a PERCENTAGE side is a fraction of (kind 4; kind 5 is `fit-content` capped
// at such a fraction).
// `px` is the CONSTANT TERM beside a fraction (kinds 4 and 5): a `calc(25% + 10px)` track is
// `frac * content_w + px`, and a plain percentage sends 0. It is no part of the other kinds — an intrinsic
// reference has no constant and a px track carries its figure in `val`.
fn resolve_track_side(kind: u8, val: f64, col: (f64, f64), content_w: f64, px: f64) -> f64 {
    match kind {
        1 => col.0,
        2 => col.1,
        4 => val * content_w + px,
        5 => col.0.max((val * content_w + px).min(col.1)),
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
        base[c] = resolve_track_side(t.base_kind, t.base_val, col, content_w, t.base_px);
        limit[c] = if t.is_fr { base[c] } else { resolve_track_side(t.limit_kind, t.limit_val, col, content_w, t.limit_px) };
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
// A declared grid line as a 1-based line NUMBER: a negative one counts back from the end of the track list
// (`-1` is the line after the last track), so `1 / -1` — the full-bleed idiom — is every column there is.
// Mirrors the oracle's `gridLine`.
fn grid_line(n: f64, cols: usize) -> f64 {
    if n < 0.0 { cols as f64 + 1.0 + n + 1.0 } else { n }
}
// Item `k`'s (start column, span) resolved against a track list `cols` long, from the LINES it declared
// (`gridColumnPlacement`: start, end, explicit `span N` — 0 for "auto" in each). The oracle's `gridColumnStart`
// / `gridColumnSpan` with the same count give the same answer; the count is what an `auto-fill` repeat makes
// vary, which is why the lines cross unresolved.
fn grid_item_columns(grids: &[f64], place_base: usize, k: usize, cols: usize) -> (Option<usize>, usize) {
    let (start_n, end_n, span_n) = (grids[place_base + 3 * k], grids[place_base + 3 * k + 1], grids[place_base + 3 * k + 2]);
    let span = if span_n > 0.0 {
        span_n as usize
    } else if start_n != 0.0 && end_n != 0.0 {
        (grid_line(end_n, cols) - grid_line(start_n, cols)).max(1.0) as usize
    } else {
        1
    };
    let start = if start_n == 0.0 {
        None
    } else {
        let idx = grid_line(start_n, cols) - 1.0;
        if idx >= 0.0 && (idx as usize) < cols { Some(idx as usize) } else { None }
    };
    (start, span.clamp(1, cols.max(1)))
}
// How many columns the template makes in a content box `content_w` wide: the marshalled specs as they stand,
// with the `auto-fill` / `auto-fit` repeat inside them made as many copies as fit. Mirrors the oracle's
// `autoRepeatCount` — how many fit is decided by each body track's MINIMUM (a `minmax(200px, 1fr)` card grid
// fits `content_w / 200` of them and the `1fr` shares out the rest), the minimum falling back to the maximum
// where it isn't a definite length; a pattern with nothing definite in it, or no width to fit against, is ONE
// repetition. `auto-fit` then collapses the copies placement leaves empty.
fn grid_repeat_count(grids: &[f64], gs: usize, tmpl_base: usize, content_w: f64, gap: f64, place_base: usize, n_items: usize) -> usize {
    let repeat_kind = grids[gs + 8] as u8;
    let repeat_len = grids[gs + 7] as usize;
    if repeat_kind == 0 || repeat_len == 0 || grids[gs + 6] < 0.0 {
        return 1;
    }
    let repeat_start = grids[gs + 6];
    if !content_w.is_finite() {
        return 1; // no width to fit against — §7.2.3.2 gives it one copy
    }
    let fixed_of = |kind: u8, val: f64| match kind {
        0 => Some(val),
        4 => Some(val * content_w),
        _ => None,
    };
    let mut per = 0.0f64;
    for k in 0..repeat_len {
        let t = GridTrack::decode(grids, tmpl_base + GRID_TRACK_STRIDE * (repeat_start as usize + k));
        // (…the constant term beside a fraction rides along: `calc(25% + 10px)` is a DEFINITE track for the
        // repeat count as much as `25%` is. Added to kind 0 as well, where it is always 0 — the marshaller
        // sends a constant only beside a FRACTION — rather than repeating the kind test `fixed_of` just made.)
        let fixed = fixed_of(t.base_kind, t.base_val).map(|f| f + t.base_px)
            .or_else(|| fixed_of(t.limit_kind, t.limit_val).map(|f| f + t.limit_px));
        match fixed {
            Some(f) if f > 0.0 => per += f + gap,
            _ => return 1,
        }
    }
    if per <= 0.0 {
        return 1;
    }
    let fits = (((content_w + gap) / per).floor() as usize).max(1);
    if repeat_kind == 2 {
        let spanned: usize = (0..n_items)
            .map(|k| grid_item_columns(grids, place_base, k, fits * repeat_len).1)
            .sum();
        if spanned > 0 {
            return fits.min(spanned.div_ceil(repeat_len)).max(1);
        }
    }
    fits
}
// The marshalled specs with the repeat made `count` copies — the track list both engines size, and how many
// columns that is. Mirrors `expandTemplate`.
fn grid_expanded_tracks(grids: &[f64], gs: usize, tmpl_base: usize, literal: usize, count: usize) -> Vec<GridTrack> {
    let decode = |c: usize| GridTrack::decode(grids, tmpl_base + GRID_TRACK_STRIDE * c);
    let repeat_len = grids[gs + 7] as usize;
    if grids[gs + 8] as u8 == 0 || repeat_len == 0 || grids[gs + 6] < 0.0 || repeat_len > literal {
        return (0..literal).map(decode).collect();
    }
    let start = (grids[gs + 6] as usize).min(literal - repeat_len);
    let mut out: Vec<GridTrack> = (0..start).map(decode).collect();
    for _ in 0..count {
        out.extend((start..start + repeat_len).map(decode));
    }
    out.extend((start + repeat_len..literal).map(decode));
    out
}
// Row-major auto-placement, mirroring the oracle (`layoutGrid` / `gridColumnContent` agree on the columns): an
// explicit start that fits resets the column (a new row if the cursor already passed it); otherwise a span that
// would overflow wraps; a filled row advances at once. `grids[place_base + 3k ..]` holds item k's declared lines
// (`grid_item_columns`). Shared by the content measure (which columns an item contributes to) and the layout.
fn grid_placement(grids: &[f64], place_base: usize, col_count: usize, n_items: usize) -> Vec<GridCell> {
    let mut cells = Vec::with_capacity(n_items);
    let mut col = 0usize;
    let mut row = 0usize;
    for k in 0..n_items {
        let (start_idx, span) = grid_item_columns(grids, place_base, k, col_count);
        let start_f = start_idx.map_or(-1.0, |i| i as f64);
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
            text_intrinsic(&runs[rs..re], &run_texts[rs..re], n.ws_mode,
                           // …CLAMPED at a basis of ZERO, which is what an intrinsic measure has: a
                           // `clamp(5px, 50%, 30px)` indent contributes its LOWER bound there, not its
                           // constant term. Without the clamp here the measure took 0 where the oracle takes
                           // 5, and the 39 mismatches that found it were the first cases any sweep had of an
                           // indent inside a comparison function.
                           (clamp_affine(n.indent_px, n.indent_lo, n.indent_hi, 0.0), n.indent_hanging, n.indent_each_line, n.indent_spent),
                           inputs, runs, run_texts, grids, children)
        }
        // …a LIST BOX excepted: its rows ARE CSS content, and the oracle's `minContentWidth` reads them (it asks
        // `contentIntrinsicWidths` for one rather than the control's own width).
        _ if n.replaced && !n.lays_out_children => Some((0.0, 0.0)), // a replaced box holds no CSS content
        // A GRID answers with its own algorithm: each TRACK contributes the figure its spec names — a length, or
        // the column's content min / max where it asks for one — and the gaps between them add on (CSS Grid §12.5:
        // the container's min-content is the sum of its columns' min-content sizes, its max-content the sum of
        // their max-content sizes). A percentage track and a percentage gap resolve against nothing here, as every
        // percentage does in an intrinsic measure.
        DISPLAY_GRID if n.grid_start >= 0 => {
            let gs = n.grid_start as usize;
            let literal = *grids.get(gs)? as usize;
            let tmpl_base = gs + GRID_HEADER;
            let kids: Vec<usize> = children[i].iter().copied().filter(|&c| inputs[c].get().out_of_flow == 0).collect();
            let place_base = tmpl_base + GRID_TRACK_STRIDE * literal;
            if literal == 0 || place_base + 3 * kids.len() > grids.len() {
                return None;
            }
            // An intrinsic measure has NO width for an `auto-fill` / `auto-fit` repeat to fit against, so it
            // makes the one copy §7.2.3.2 gives it — where the layout makes as many as its content box holds.
            let count = grid_repeat_count(grids, gs, tmpl_base, f64::NAN, 0.0, place_base, kids.len());
            let tracks = grid_expanded_tracks(grids, gs, tmpl_base, literal, count);
            let col_count = tracks.len();
            let cells = grid_placement(grids, place_base, col_count, kids.len());
            let cols = grid_column_content(&kids, &cells, col_count, inputs, runs, run_texts, grids, children)?;
            let gaps = grids[gs + 1] * (col_count as f64 - 1.0).max(0.0);
            let mut min = gaps;
            let mut max = gaps;
            // A PERCENTAGE track (kind 4, or `fit-content` of one, kind 5) has nothing to be a percentage OF
            // here, and behaves as `auto` — the column's own content (Chrome: a `grid-template-columns: 50%` grid
            // measures its column's min and max).
            let side = |kind: u8, val: f64, col: (f64, f64), want_max: bool| -> f64 {
                match kind {
                    4 | 5 => if want_max { col.1 } else { col.0 },
                    _ => resolve_track_side(kind, val, col, 0.0, 0.0),
                }
            };
            // §12.7 Expand Flexible Tracks: with no space to fill, the `fr` tracks do NOT each take their own
            // content — they take the LARGEST share any one of them asks for, times their own flex factor. So
            // `1fr 2fr` holding a 34px item and a 16px one measures 34 + 68, not 34 + 16. (A flex factor below
            // one asks for its content whole — the sum it divides is floored at 1.) The MIN-content side expands
            // nothing: every track is its base size there.
            let base_of = |c: usize, t: &GridTrack| side(t.base_kind, t.base_val, cols[c], false);
            let used_fr = tracks
                .iter()
                .enumerate()
                .filter(|(_, t)| t.is_fr)
                .fold(0.0f64, |acc, (c, t)| acc.max(base_of(c, t).max(cols[c].1) / t.fr_weight.max(1.0)));
            for (c, t) in tracks.iter().enumerate() {
                let floor = base_of(c, t);
                if t.is_fr {
                    min += floor;
                    max += floor.max(used_fr * t.fr_weight);
                } else {
                    min += floor;
                    max += side(t.limit_kind, t.limit_val, cols[c], true);
                }
            }
            Some((min, max))
        }
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
            let max = max.max(line);
            // …and a NON-WRAPPING block container is ONE unbreakable token whatever it holds, its block children
            // and its floats' line included: the oracle ends `contentIntrinsicWidths` with `min = max` for a
            // `nowrap` / `pre` box that does not blockify (a flex container's items are blocks of their own, so it
            // pins nothing), and parity is the bar. It is the ORACLE's rule, not Chrome's: Chrome pins only inline
            // content, so a float, or a child that declares a wrapping mode of its own, keeps its min-content there
            // — the only cases where this pin changes anything, each pinned as a shared gap in the specs. (A child
            // with no mode of its own already pinned itself; the walk declined every such box until 2026-09-24.)
            if n.display == DISPLAY_BLOCK && matches!(n.ws_mode, 1 | 2) {
                return Some((max, max));
            }
            Some((min, max))
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
    if n.replaced && !n.ratio_only && !n.lays_out_children {
        return Some(n.intrinsic_w); // the oracle's minContentWidth: the intrinsic width, edges not counted
    }
    // A TABLE answers for itself, and its figure is already a BORDER box (the frame included), so no edges go on
    // top of it — `intrinsic_widths` returns its own algorithm's, a declared width still pinning it, exactly as
    // the oracle's `minContentWidth` reads `intrinsicWidths(el).min` for one.
    if n.display == DISPLAY_TABLE {
        return Some(intrinsic_widths(i, inputs, runs, run_texts, grids, children)?.0);
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
        // The main gap with NO basis, as every percentage is in an intrinsic measure: its length part, clamped by
        // its bounds (the oracle's `axisGap(el, …, null)`) — a percentage part is nothing here, so a `10%` gap adds
        // 0 and a `calc(10% + 4px)` one 4, where the walk refused every such container as unmeasurable.
        let gaps = clamp_affine(n.flex_main_gap, n.flex_main_gap_lo, n.flex_main_gap_hi, 0.0) * (count as f64 - 1.0);
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
#[allow(clippy::too_many_arguments)]
// `clamp(lo, v, hi)` where each bound is its own affine function of the basis — the one arithmetic the two
// engines have to agree on for a comparison function (`nlClampedAt` in layout.js is the same three lines) — in
// CSS's order, `max(lo, min(v, hi))`: where the bounds cross, `clamp()`'s MINIMUM wins.
fn clamp_affine(v: f64, lo: (f64, f64), hi: (f64, f64), basis: f64) -> f64 {
    v.min(hi.0 + hi.1 * basis).max(lo.0 + lo.1 * basis)
}
fn text_intrinsic(runs: &[Run], run_texts: &[Option<Vec<u16>>], ws_mode: u8, indent: (f64, bool, bool, bool), inputs: &[Cell<Input>], all_runs: &[Run], all_texts: &[Option<Vec<u16>>], grids: &[f64], children: &[Vec<usize>]) -> Option<(f64, f64)> {
    // …per RUN, because an inline may declare its own `white-space` (`Run::ws_mode`) and every one of these is
    // about the run it belongs to. `pin` is the exception: "this box never wraps, so its min-content IS its
    // max-content" is a statement about the whole stream, true only while no run in it wraps.
    // …(wraps, preserves, a newline forces a break, and `break-spaces`' own rule for what a preserved space
    // DOES). `break-spaces` wraps and preserves exactly as `pre-wrap` does — which is why `line_layout` takes
    // the two together — and differs only here: a `pre-wrap` space is a gap the line may break BEFORE and that
    // HANGS off the end, while a `break-spaces` space is CONTENT that joins the word, never hangs, and carries
    // the opportunity AFTER it. So the min-content of `aa   bb` is `aa ` wide (28.8) where `pre-wrap` gives
    // `aa` (19.2). Chrome-measured, and the oracle's `contentIntrinsicWidths` says the same.
    let modes = |m: u8| match m {
        0 => Some((true, false, false, false)),  // normal:   wraps, collapses, no forced newline
        1 => Some((false, false, false, false)), // nowrap
        2 => Some((false, true, true, false)),   // pre
        3 => Some((true, true, true, false)),    // pre-wrap
        4 => Some((true, false, true, false)),   // pre-line
        5 => Some((true, true, true, true)),     // break-spaces
        _ => None,
    };
    // `pin` — "this box never wraps, so its min-content IS its max-content" — is the BLOCK's, not the runs':
    // the oracle ends `contentIntrinsicWidths` with `NON_WRAPPING_WS.has(whiteSpaceOf(el))`, asked of the
    // ELEMENT. A wrapping inline inside a `nowrap` block does not unpin it.
    let pin = !modes(ws_mode)?.0;
    // …while the four behaviours are set from each RUN's own mode as the loop reaches it.
    let (mut wraps, mut preserve, mut break_nl, mut brk_spaces);
    let (mut min, mut max) = (0.0f64, 0.0f64);
    let (mut line, mut word) = (0.0f64, 0.0f64);
    // `text-indent` narrows the line it applies to, so both figures carry it — and it is TAKEN by the first thing
    // that occupies the line (a word, an atomic, an inline box, a `<br>`, a `<wbr>`, a preserved segment), never
    // seeded into the pen: a line nothing occupies carries none (the oracle's `takeIndent`, Chrome-measured — an
    // empty `<td>` under an inherited indent is 0 wide). `hanging` indents every line BUT the first, and after a
    // forced break `each-line` arms the next one (inverted again under `hanging each-line`); every line an
    // intrinsic measure closes is a forced one, since it has no room to wrap in.
    // …and the FIRST line is the block's first only where nothing SPENT it: a mixed block's anonymous group after
    // a block child starts on a line that is not (`indent_spent`), where the oracle's pen has closed a line for
    // the block child and re-armed the indent as any non-first line — `hanging ? px : 0`. The same test the flow
    // makes (`line_layout`'s `indent_first != indent_hanging`); without it the measure indented a group the
    // layout did not (30.2 where the oracle says 20.6).
    let (indent_px, indent_hanging, indent_each_line, indent_spent) = indent;
    let mut pending_indent = if !indent_spent != indent_hanging { indent_px } else { 0.0 };
    macro_rules! take_indent {
        () => {{
            line += pending_indent;
            word += pending_indent;
            pending_indent = 0.0;
        }};
    }
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
            pending_indent = if indent_each_line { if indent_hanging { 0.0 } else { indent_px } }
                             else if indent_hanging { indent_px } else { 0.0 };
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
        (wraps, preserve, break_nl, brk_spaces) = modes(run.ws_mode)?;
        match run.kind {
            RUN_BR => {
                take_indent!(); // a `<br>` occupies its line, so the line it ends carries the indent
                end_line!();
            }
            RUN_WBR => {
                take_indent!();
                opportunity!();
            }
            // An OUT-OF-FLOW box is not in the flow's inline stream: it contributes no advance to either
            // intrinsic width and brings no break opportunity — it is only a marker of where the flow reached,
            // and an intrinsic measure has no lines for that to mean anything on.
            RUN_OOF => {}
            // A FLOAT packs beside its neighbours as an inline-level box does (a box holding two 50px floats wants
            // 100 at max-content, 50 at min-content), its margins with it — but it is not inline CONTENT: it takes
            // no pending space and brings no break opportunity (the oracle's float arm).
            RUN_FLOAT => {
                let c = run.font as usize;
                let (imin, imax) = intrinsic_widths(c, inputs, all_runs, all_texts, grids, children)?;
                let m = inputs[c].get().decl_margin_x;
                line += imax + m;
                min = min.max(imin + m);
            }
            RUN_OPEN => {
                take_indent!(); // an inline box occupies the line, edges or not
                // An inline's EDGES here are the BASIS-LESS ones (`Run::plain`): an intrinsic measure
                // has no percentage basis, so a `padding: 0 10%` inline contributes nothing where the laid-out
                // line counts its resolved px.
                // The matching CLOSE (LIFO) — an inline with ANY horizontal edge takes the pending space at its open.
                let mut depth = 0i32;
                let mut close = None;
                for r in &runs[ri + 1..] {
                    match r.kind {
                        RUN_OPEN => depth += 1,
                        RUN_CLOSE if depth == 0 => {
                            close = Some(r.plain);
                            break;
                        }
                        RUN_CLOSE => depth -= 1,
                        _ => {}
                    }
                }
                if run.plain + close? != 0.0 {
                    take_pending!();
                }
                line += run.plain;
                word += run.plain;
            }
            RUN_CLOSE => {
                line += run.plain;
                word += run.plain;
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
                            } else if preserve && text[i] != 0x20 && text[i] != 0x09 {
                                return None; // a PRESERVED \r / \f — not modelled (a collapsing mode collapses both,
                                             // as the line layout does: right for CR, SHARED-wrong for FF — Chrome
                                             // draws FF as a glyph with no break, pinned in the text spec)
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
                            take_indent!(); // this segment occupies its line, an EMPTY one too
                            for &u in &text[start..i] {
                                if u == 0x0A {
                                    end_line!();
                                    take_indent!();
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
                                    // …and under `break-spaces` the space is CONTENT: it joins the word like a
                                    // non-wrapping one and takes its opportunity AFTER, where a `pre-wrap` space
                                    // opens one BEFORE and hangs outside the word it follows.
                                    if wraps && !brk_spaces {
                                        opportunity!();
                                    } else {
                                        word += adv;
                                    }
                                    line += adv;
                                    if brk_spaces {
                                        opportunity!();
                                    }
                                }
                            }
                        } else if break_nl && nl > 0 {
                            for _ in 0..nl {
                                end_line!(); // pre-line: a newline is a line end, the spaces around it collapse away
                            }
                        } else if inline_on_line {
                            // A collapsed space: pending after content on the line, nothing at all at a line start
                            // — deleted there (CSS Text 3 §4.1.2), and no break opportunity with it: it used to be
                            // one, "a no-op, the word is empty", which an inline box's edges or the indent it took
                            // made false (the oracle's pen, the same change).
                            pend!(space_w);
                        }
                    } else {
                        let start = i;
                        while i < text.len() && !is_ws_u16(text[i]) {
                            i += 1;
                        }
                        // A word takes the pending space ONCE — the one before it in this run, or an earlier run's
                        // trailing space (a word glued to the previous run, nothing pending, continues that word).
                        // …and the line's indent before it, so a TAB inside the word measures from the indented pen.
                        take_indent!();
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
                take_indent!();
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
// item). Bare text directly in the grid is an anonymous ITEM with a box of its own (CSS Grid §4, `gridItems`
// in `layout.js`), placed in a row like any other item and walked here as an ordinary block record with no
// element behind it — so `anon_cross` arrives as 0 for a grid and the floor it carries is FLEX's alone. It
// floored a grid's auto height until 2026-09-22, which overrode a declared `grid-auto-rows` (22 against
// Chrome's 5) in both engines at once. An out-of-flow child joins no row: its subtree lays out at its
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
    let literal = grids[gs] as usize;
    // The gaps arrive as `px + fraction` of the content box along their axis (`gapSpec`): a row gap's fraction
    // resolves against the content height where that is DEFINITE — declared or imposed — and is nothing where the
    // height is the rows' own, as the oracle's `layoutGrid` has it.
    let col_gap = clamp_affine(grids[gs + 1] + grids[gs + 2] * content_w,
                               (grids[gs + 9], grids[gs + 10]), (grids[gs + 11], grids[gs + 12]), content_w);
    let row_h = n.definite_content_h().unwrap_or(0.0);
    let row_gap = clamp_affine(grids[gs + 3] + if grids[gs + 4] != 0.0 { grids[gs + 4] * row_h } else { 0.0 },
                               (grids[gs + 13], grids[gs + 14]), (grids[gs + 15], grids[gs + 16]), row_h);
    let decl_row_h = grids[gs + 5];
    let tmpl_base = gs + GRID_HEADER;
    // The in-flow items, in record order — the out-of-flow children join no row.
    let kids: Vec<usize> = children[i].iter().copied().filter(|&c| inputs[c].get().out_of_flow == 0).collect();
    // Template is GRID_TRACK_STRIDE values per marshalled column; placement is 3 per in-flow item.
    let place_base = tmpl_base + GRID_TRACK_STRIDE * literal;
    if literal == 0 || place_base + 3 * kids.len() > grids.len() {
        return bail(failed);
    }
    // …and how many columns those specs actually make is this box's own answer: an `auto-fill` / `auto-fit`
    // repeat makes as many copies as THIS content box fits, with the gap between them counting toward each. The
    // oracle counts them against its own `content_w`; the two figures are the same box, so they must agree
    // bit-for-bit — a 1-ulp difference at an exact boundary is a whole column, not a rounding error.
    let count = grid_repeat_count(grids, gs, tmpl_base, content_w, col_gap, place_base, kids.len());
    let tracks = grid_expanded_tracks(grids, gs, tmpl_base, literal, count);
    let col_count = tracks.len();
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

    // …and on the BLOCK axis its containing block is the ROW: a DECLARED row height is that basis outright,
    // and where the rows are content-sized the grid's own definite content height stands in. Loop-invariant,
    // so it is computed once — a grid item's sizing is a hot path (rule 3).
    // The fallback is right for the single row a grid usually has and wrong otherwise, and the walk shares it:
    // `grid-auto-rows` is the only row declaration either engine reads (`gridRowHeight`), a content row's
    // height is not known until its items are measured, and a `grid-row: span` is not modelled. Recorded, not
    // fixed here — Chrome gives a `height: 50%` item in the second of two content rows 50 where both say 150.
    let pct_h = if is_auto(decl_row_h) { n.definite_content_h().unwrap_or(f64::NAN) } else { decl_row_h };
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
        // A grid item's containing block is its TRACK, not the grid's content box (§12.1): its percentage
        // width, min/max-width and EDGES all resolve against that — all four edges against the INLINE size,
        // as everywhere else. The generic child pass above resolved them against this box's content width,
        // because it has no tracks to hand out, so they are re-resolved here now that the track is known.
        // (Idempotent: `with_percent_sizes` always re-derives from `pct_sizes` / `edge_frac`, which are never
        // written back, so a second measure at another width is clean. A SPANNING item's basis is the tracks
        // it covers plus the gaps between them, which `track_w` already is.)
        let mut item = inputs[c].get();
        if item.has_percent_sizes() {
            item = item.with_percent_sizes(track_w, pct_h);
            inputs[c].set(item);
        }
        // …and an intrinsic-size KEYWORD width is the item's own content measured against that AREA: `fit-content`
        // is the room the area leaves clamped between its min- and max-content, as `block_child_width` gives a
        // block child the room its containing block leaves.
        let child_w = if item.width_kw != 0 {
            let room = (track_w - Input::m(item.ml) - Input::m(item.mr)).max(0.0);
            match content_sized_width(c, room, inputs, runs, run_texts, grids, children) {
                Some(w) => used_width(&item, w),
                None => {
                    failed.set(true);
                    0.0
                }
            }
        } else {
            resolve_width(&item, track_w)
        };
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
    boxes[i].clamped_h = is_auto(n.height) && boxes[i].h != box_h;
    boxes[i].auto_height = is_auto(n.height);
    // A grid establishes an independent formatting context: its margins do not collapse with its items'.
    let top = CMargin::of(Input::m(n.mt));
    MInfo { top, top_only: top, bottom: CMargin::of(Input::m(n.mb)), collapse_through: false }
}

// A container's first / last baseline from its children in the given order — the first that has a first
// baseline and the last that has a last baseline, each offset by the child's relative top; out-of-flow and
// floated children give none (the oracle's `baselineCandidates`).
// What a box hands its PARENT under the ATOMIC rules — the rule `boxBaselineOffset` applies to the box it is
// looking AT, at every level of the walk while its `inlineBlock` flag is set: a scroll container gives its
// bottom margin edge (a BUTTON excepted, which is a button however it scrolls) and masks everything inside it,
// anything else hands over what its own children gave it. `Box::inline_block_baseline` is only that second
// half, so a table's CELL, ROW or ROW GROUP that is itself a scroll container needs this on top of it (120
// shapes of a 2744-case sweep: the oracle's line 22 against native's 18).
fn atomic_baseline_of(b: usize, inner: Option<f64>, inputs: &[Cell<Input>], boxes: &[Box]) -> Option<f64> {
    let k = inputs[b].get();
    if k.scrolls_y && !k.is_button { Some(boxes[b].h + Input::m(k.mb)) } else { inner }
}
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
        //
        // …and a TABLE child answers NOTHING here, at every level: an atomic hangs from a LINE BOX (CSS 2.1
        // §10.8.1) and a table generates none, so an `inline-block` whose content is a table — however deep —
        // hangs from its bottom margin edge. That is the oracle's rule: `boxBaselineOffset` carries its
        // `inlineBlock` flag down the whole recursion, and `baselineCandidates` skips every table-display
        // child while it is set. The `first` / `last` answers above are untouched, because those are what a
        // flex line and a baseline-aligned cell read, and a table does answer them.
        //
        // RECORDED, not fixed: Chrome asks the CONTAINER KIND instead — a box whose own baseline comes from
        // LINE BOXES refuses a table child (inline-block, all three engines 22 / 14), but a FLEX or GRID
        // container's baseline IS its first item's, table included (Flexbox §8.5, Align §9: Chrome 18 / 10
        // where both engines give 22 / 14; 21 vs 25 for a `<button style="display:inline-flex">`).
        if cn.display != DISPLAY_TABLE {
            if cn.scrolls_y && !cn.is_button {
                inline_block = Some(boxes[c].y + boxes[c].h + Input::m(cn.mb));
            } else if let Some(b) = boxes[c].inline_block_baseline {
                inline_block = Some(boxes[c].y + b);
            }
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
    shift_frags(i, bx, by);
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
    // (its border box less its borders, final by the time `place` reaches here), from its fragments where it is an
    // inline box of the pass, else the rectangle the walk pushed for a CB outside the pass (the viewport, an
    // ancestor above the root).
    let declared = inputs[c].get();
    let (cb_x, cb_y, cb_w, cb_h) = if declared.cb_index == CB_RECT {
        (declared.cb_rect[0], declared.cb_rect[1], declared.cb_rect[2], declared.cb_rect[3])
    } else if declared.cb_index == CB_INLINE {
        match inline_padding_box(declared.cb_rect[0] as usize) {
            Some(b) => b,
            None => {
                failed.set(true);
                return;
            }
        }
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
    // Between BOTH insets the room is what they leave less the box's own margins — what an auto width fills and
    // what an intrinsic-size keyword measures against (the oracle's stretched `autoW`, which `usedSize` hands both
    // uses). A keyword width is no `auto`, though: it takes its own figure of that room rather than filling it.
    let fill_w = (avail_w - ml - mr).max(0.0);
    let auto_w = if (stretched && n.width_kw == 0) || (n.replaced && n.ratio_only) {
        fill_w
    } else if !is_auto(n.width) {
        // A DECLARED width: `used_width` answers from the declaration and discards `auto_w`, so the
        // shrink-to-fit measure is not merely wasted work (an O(subtree) walk per out-of-flow box) — asked, it
        // descends where the WALK did not gate for it. The record's `decl_w` is basis-less, so a PERCENTAGE
        // width reads as `auto` inside `intrinsic_widths` and the walk it short-circuits for a length runs
        // after all: a `position: absolute; width: 50%` box holding an atomic native cannot measure failed the
        // whole pass over a figure nobody reads.
        0.0
    } else {
        // …an AUTO width shrinks to fit the room its insets leave, and an intrinsic-size KEYWORD asks its own
        // figure of it (`content_sized_width`: `fit-content` is the room clamped between the box's min- and
        // max-content) — of `fill_w` where both insets are given, as above.
        let room = if stretched { fill_w } else { avail_w };
        match content_sized_width(c, room, inputs, runs, run_texts, grids, children) {
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
    // …a REPLACED box excepted: its height is its own intrinsic size, which §10.6.5 keeps whatever the insets say
    // (the oracle's `usedSize` keeps it; native stretched an inset `<input>` / list box to the inset height).
    let imposed = if is_auto(n.height) && auto_h > 0.0 && !n.replaced { auto_h } else { f64::NAN };
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
    } else if pn.from_right() && pn.display != DISPLAY_TABLE {
        // …and an inline axis running from the RIGHT puts the static corner at the content's right edge, less
        // the box (`staticCornerFor`, which asks for that physical side — a vertical mode's rtl has none).
        // A TABLE is the one container that does NOT: `layoutTable` places its out-of-flow children with no
        // aligned corner at all (`placeAbsolute(child, pos, content.x, gridTop, ctx)` — it stops at `ctx`,
        // where block flow and grid go on to pass `order` and `staticAlign`), so an rtl table leaves one at
        // its content's LEFT edge. Chrome
        // puts it at the right, like every other rtl container; that is an oracle divergence recorded rather
        // than fixed while the port is running, and fixing it means giving the ORACLE the corner it skips.
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
    shift_frags(c, x, y);   // …and its own lines' inline fragments with it, as `place` moves a flowed box's
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
    //
    // …except for an ANONYMOUS block box, which the flow creates and the ORACLE gives its parent's content
    // width outright. A mixed block's group inherits the parent's `writing-mode` like any anonymous box, so
    // the vertical arm above used to catch it and shrink-to-fit it — and then a `text-align: center` had
    // nothing to centre in: the atomic sat at 28.8 where the oracle put it at 145.5, on 400 of 4,032 shapes
    // (`sweeps/genvwmmix.rb`, the cross of a writing mode with a mixed block, which no generator had).
    // Reproducing the oracle here rather than the spec on purpose: NEITHER engine lays vertical text out —
    // both put the atomic at the same `y` and move it along `x` — and Chrome, which does, says 262.5/28.81
    // to our 145.5/19. The whole area is an approximation shared by the two engines, and the campaign's bar is
    // that they share it. Real vertical inline layout is its own project; see the sweep.
    // …and the exemption is the TEXT BLOCK specifically, not "anonymous". The other three anonymous kinds take
    // their width from somewhere else entirely — a cell from its COLUMN, a grid item from its AREA — and none
    // of them reaches block flow today (`measure` routes on `display` with no fallback, and an instrumented run
    // over ~90k corpus shapes saw only `DISPLAY_TEXT_BLOCK` arrive here). What makes the narrow test worth
    // writing anyway is the kind that does NOT exist yet: block-in-inline, which a real browser splits into
    // anonymous BLOCKS and this engine does not (see layout.js's note at `placeInlineBox`). Those would arrive
    // here as `DISPLAY_BLOCK`, and a blanket `is_anonymous()` would hand each one its parent's width without
    // anyone deciding that it should get one.
    let anon_group = cn.is_anonymous() && cn.display == DISPLAY_TEXT_BLOCK;
    let content_sized = cn.width_kw != 0 || (is_auto(cn.width) && ((cn.block_axis_is_x && !anon_group) || cn.is_button));
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
        kw => intrinsic_widths(c, inputs, runs, run_texts, grids, children)
            .map(|(imin, imax)| keyword_width(kw, imin, imax, room, cn.pct_edges_x())),
    }
}
// …the keyword arithmetic alone, over a pair already in hand: `min-content` and `max-content` take their side
// outright and `fit-content` takes the room clamped between them — min-content winning where the two figures
// cross (a negative margin can take max-content under the widest piece), as the oracle's
// `Math.max(min, Math.min(max, …))` has it. Each carries back the percentage part of the box's own edges, which
// an intrinsic CONTRIBUTION leaves out. Shared with `measure_table`'s caption, whose pair may be the ORACLE's
// pushed one rather than a measure of its own.
fn keyword_width(kw: u8, imin: f64, imax: f64, room: f64, pct: f64) -> f64 {
    match kw {
        1 => imin + pct,
        2 => imax + pct,
        _ => (room - pct).min(imax).max(imin) + pct,
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
            rel_pct: [f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, 0.0, 0.0],
            flex_item_auto: 0,
            flex_baseline_asc: f64::NAN,
            flex_line_nat: f64::NAN,
            flex_line: f64::NAN,
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
            height_from_outside: false,
            lays_out_children: false,
            indent_frac: 0.0,
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
            pct_px: [0.0; 6],
            pct_lo: [(f64::NEG_INFINITY, 0.0); 6],
            pct_hi: [(f64::INFINITY, 0.0); 6],
            edge_frac: [0.0; 8],
            edge_px: [0.0; 8],
            inset_frac: [0.0; 4],
            flex_main_gap_frac: 0.0,
            flex_main_gap_lo: (f64::NEG_INFINITY, 0.0),
            flex_main_gap_hi: (f64::INFINITY, 0.0),
            flex_cross_gap_lo: (f64::NEG_INFINITY, 0.0),
            flex_cross_gap_hi: (f64::INFINITY, 0.0),
            indent_lo: (f64::NEG_INFINITY, 0.0),
            indent_hi: (f64::INFINITY, 0.0),
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
            cell_pct_h_child: false,
            anon_group: false,
            group_pct_h: f64::NAN,
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
            cb_index: CB_NONE,
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
            Outcome::LaidOut(b, _) => b,
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1], Box { nid: 1.0, x: 0.0, y: 0.0, w: 800.0, h: 50.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None, clamped_h: false });
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 50.0, w: 800.0, h: 30.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None, clamped_h: false });
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 300.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 100.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[1].h, 120.0); // owner contains the float
        assert_eq!(bx[2], Box { nid: 2.0, x: 0.0, y: 0.0, w: 80.0, h: 120.0, auto_height: false, first_baseline: None, last_baseline: None, inline_block_baseline: None, natural_h: None, clamped_h: false });
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
            let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
            assert_eq!([bx[1].x, bx[2].x, bx[3].x], xs, "justify code {code}");
        }
    }

    #[test]
    fn flex_row_gap_and_margins() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_gap = 20.0;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!([bx[1].x, bx[2].x, bx[3].x], [0.0, 120.0, 240.0]); // 100 + 20 gap

        // A left margin on the middle item pushes it (and the run after) right.
        let mut m = item(2.0, 0, 100.0, 30.0);
        m.ml = 15.0;
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), m, item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
            let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let b = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
            let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 20.0);
        assert_eq!(bx[1].y, 0.0);
    }

    #[test]
    fn flex_column_stacks_items_and_auto_height_sums_them() {
        let inputs = vec![flex_col(0.0, -1, 200.0), item(1.0, 0, 50.0, 30.0), item(2.0, 0, 50.0, 30.0), item(3.0, 0, 50.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        // free = 200 - 90 = 110; center lead = 55 → y 55 / 85 / 115.
        assert_eq!([bx[1].y, bx[2].y, bx[3].y], [55.0, 85.0, 115.0]);
        assert_eq!(bx[0].h, 200.0);
    }

    #[test]
    fn flex_column_cross_align_center_on_x() {
        let mut a = item(1.0, 0, 50.0, 30.0);
        a.flex_cross_align = 1; // center on the cross (X) axis
        let inputs = vec![flex_col(0.0, -1, 200.0), a];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 90.0);
        assert_eq!(bx[1].y, 60.0); // extent 90, free 60, end
    }

    #[test]
    fn flex_row_reverse_places_from_the_right() {
        let mut f = flex(0.0, -1, 600.0);
        f.flex_main_reverse = true;
        let inputs = vec![f, item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 30.0), item(3.0, 0, 100.0, 30.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[3].y, 40.0); // 30 (line 0) + 10 (cross gap)
        assert_eq!(bx[0].h, 70.0); // 30 + 10 + 30
    }

    #[test]
    fn flex_row_auto_height_wraps_the_tallest_item() {
        let inputs = vec![flex(0.0, -1, 600.0), item(1.0, 0, 100.0, 30.0), item(2.0, 0, 100.0, 50.0)];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].h, 50.0); // auto height = tallest item outer
        assert!(bx[0].auto_height);
    }

    #[test]
    fn unsupported_subtree_declines() {
        let mut a = blk(1.0, 0);
        a.display = DISPLAY_UNSUPPORTED; // e.g. flex
        let inputs = vec![blk(0.0, -1), a];
        assert!(matches!(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0), Outcome::Unsupported));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
            tbl(0.0, -1, 4.0, 4.0),            // 0 table (wrapper); the caption's side top (0 = default)
            caption(1.0, 0, 100.0, 16.0),      // 1 caption (block, 100x16)
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3 td col 0
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4 td col 1
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        // wrapper: width = grid (60+80 + 3*4 = 152) ; height = grid (20 + 2*4 = 28) + caption 16 = 44
        assert_eq!([bx[0].w, bx[0].h], [152.0, 44.0]);
        assert_eq!([bx[1].x, bx[1].y, bx[1].w, bx[1].h], [0.0, 0.0, 100.0, 16.0]); // caption at the top
        assert_eq!([bx[3].x, bx[3].y], [4.0, 20.0]); // td col 0: grid offset DOWN by caption (16) + sy (4)
        assert_eq!([bx[4].x, bx[4].y], [68.0, 20.0]); // td col 1 = 4 + 60 + 4
    }

    #[test]
    fn table_caption_bottom_sits_below_the_grid() {
        let mut cap = caption(1.0, 0, 100.0, 16.0);
        cap.caption_side = 1; // bottom
        let inputs = vec![
            tbl(0.0, -1, 4.0, 4.0),            // 0 table (wrapper)
            cap,                               // 1 caption
            rowel(2.0, 0),                     // 2 tr
            cell(3.0, 2, 60.0, 20.0, 0, 1, 1), // 3
            cell(4.0, 2, 80.0, 20.0, 1, 1, 1), // 4
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
        assert_eq!(bx[0].w, 300.0); // wrapper widened to the caption
        assert_eq!(bx[0].h, 44.0);
        // …and the columns share out that width: the surplus over their 60/80 maximums goes to them in
        // proportion (288 assignable − 140 = 148 → 60 + 63.43 and 80 + 84.57), so the grid fills the wrapper.
        assert_eq!([bx[3].x, bx[4].x], [4.0, 131.42857142857142]);
    }

    // A caption on a table with its OWN border sits at the WRAPPER's border box — outside the border, not inset
    // into the content box: x=0 / y=0 at the top-left, the full border-box width, and the grid is offset DOWN past
    // the caption and then IN by the border. (§17.4 wrapper box.)
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let mut cap = caption(1.0, 0, 60.0, 16.0);
        cap.caption_side = 1; // bottom
        let inputs = vec![
            t,
            cap,                               // 1 caption
            rowel(2.0, 0),
            cell(3.0, 2, 40.0, 20.0, 0, 1, 1), // 3 td
        ];
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
        let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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
            let bx = boxes(layout_block(&inputs, &[], &[], &[], &[], 0.0, 0.0, 800.0));
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

    // ── the grid template's auto repeat ────────────────────────────────────────────────────────────────────
    // A marshalled grid buffer: the header, `specs` track sides (base kind/val, limit kind/val, is_fr, weight,
    // is_auto, base px, limit px) and `places` item placements (start line, end line, span) — the shape `nlShadowRun` writes.
    fn grid_buffer(literal: usize, repeat: (f64, usize, u8), specs: &[[f64; 9]], places: &[[f64; 3]]) -> Vec<f64> {
        // …GRID_HEADER wide, and the tail is the two gaps' clamped-affine BOUNDS (lo px/frac, hi px/frac per
        // axis) at their identities. Built by hand here, so the header's length is one of the three places a
        // stride change has to be made — this test file is the third, and it is the one that catches it.
        let mut g = vec![literal as f64, 0.0, 0.0, 0.0, 0.0, f64::NAN, repeat.0, repeat.1 as f64, repeat.2 as f64,
                         f64::NEG_INFINITY, 0.0, f64::INFINITY, 0.0,
                         f64::NEG_INFINITY, 0.0, f64::INFINITY, 0.0];
        for spec in specs {
            g.extend_from_slice(spec);
        }
        for place in places {
            g.extend_from_slice(place);
        }
        g
    }
    // …9 wide, spelled as a LITERAL and not as `GRID_TRACK_STRIDE`: these arrays are here to BREAK when the
    // stride moves, so that whoever moves it has to decide what the new slots hold for each track. Tying them
    // to the constant compiles clean and tests green through any change, which is the gate cancelling itself
    // — it was tied for one build, with the comment above still claiming it was the thing that catches a
    // stride change. The assert below says the same thing to anyone who tries again.
    const _: () = assert!(GRID_TRACK_STRIDE == 9, "widen the hand-built track arrays in this file too");
    const FIXED_50: [f64; 9] = [0.0, 50.0, 0.0, 50.0, 0.0, 0.0, 0.0, 0.0, 0.0]; // a plain `50px` track
    const AUTO_TRACK: [f64; 9] = [1.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0]; // `auto`: min-content base, max-content limit
    const NO_PLACE: [f64; 3] = [0.0, 0.0, 0.0];

    #[test]
    fn auto_fill_makes_as_many_copies_as_the_content_box_fits() {
        let g = grid_buffer(1, (0.0, 1, 1), &[FIXED_50], &[NO_PLACE]);
        let count = |w: f64, gap: f64| grid_repeat_count(&g, 0, GRID_HEADER, w, gap, GRID_HEADER + GRID_TRACK_STRIDE, 1);
        assert_eq!(count(400.0, 0.0), 8);
        assert_eq!(count(399.0, 0.0), 7);
        assert_eq!(count(400.0, 10.0), 6); // (400 + 10) / (50 + 10)
        assert_eq!(count(10.0, 0.0), 1); // never below one copy
        assert_eq!(count(f64::NAN, 0.0), 1); // an intrinsic measure has no width to fit against (§7.2.3.2)
        assert_eq!(grid_expanded_tracks(&g, 0, GRID_HEADER, 1, count(400.0, 0.0)).len(), 8);
    }

    #[test]
    fn a_repeat_with_nothing_definite_in_it_is_one_copy() {
        let g = grid_buffer(1, (0.0, 1, 1), &[AUTO_TRACK], &[NO_PLACE]);
        assert_eq!(grid_repeat_count(&g, 0, GRID_HEADER, 400.0, 0.0, GRID_HEADER + GRID_TRACK_STRIDE, 1), 1);
        // …and a template with no repeat at all keeps exactly the specs it was handed
        let plain = grid_buffer(2, (-1.0, 0, 0), &[FIXED_50, AUTO_TRACK], &[NO_PLACE]);
        assert_eq!(grid_repeat_count(&plain, 0, GRID_HEADER, 400.0, 0.0, GRID_HEADER + 2 * GRID_TRACK_STRIDE, 1), 1);
        assert_eq!(grid_expanded_tracks(&plain, 0, GRID_HEADER, 2, 1).len(), 2);
    }

    #[test]
    fn the_copies_land_between_the_tracks_written_out_beside_them() {
        // `40px repeat(auto-fill, 50px) auto` — the repeat is track 1 of three marshalled
        let specs = [[0.0, 40.0, 0.0, 40.0, 0.0, 0.0, 0.0, 0.0, 0.0], FIXED_50, AUTO_TRACK];
        let g = grid_buffer(3, (1.0, 1, 1), &specs, &[NO_PLACE]);
        let tracks = grid_expanded_tracks(&g, 0, GRID_HEADER, 3, 3);
        assert_eq!(tracks.len(), 5); // 40px, three copies, auto
        assert_eq!(tracks[0].base_val, 40.0);
        assert!(tracks[1..4].iter().all(|t| t.base_val == 50.0));
        assert_eq!(tracks[4].limit_kind, 2); // the `auto` suffix survives at the end
    }

    #[test]
    fn auto_fit_collapses_the_copies_placement_leaves_empty() {
        let places = [NO_PLACE, NO_PLACE];
        let g = grid_buffer(1, (0.0, 1, 2), &[FIXED_50], &places);
        let place_base = GRID_HEADER + GRID_TRACK_STRIDE;
        // eight would fit, but two items only ever occupy two
        assert_eq!(grid_repeat_count(&g, 0, GRID_HEADER, 400.0, 0.0, place_base, 2), 2);
        // …and a spanning item counts for every column it covers
        let spanning = grid_buffer(1, (0.0, 1, 2), &[FIXED_50], &[[0.0, 0.0, 3.0], NO_PLACE]);
        assert_eq!(grid_repeat_count(&spanning, 0, GRID_HEADER, 400.0, 0.0, place_base, 2), 4);
    }

    #[test]
    fn a_declared_line_resolves_against_the_track_count_it_is_read_with() {
        // `grid-column-start: -2` / `grid-column: 1 / -1` / `grid-column: 2 / span 3`
        let places = [[-2.0, 0.0, 0.0], [1.0, -1.0, 0.0], [2.0, 0.0, 3.0], [9.0, 0.0, 0.0]];
        let g = grid_buffer(1, (-1.0, 0, 0), &[FIXED_50], &places);
        let place_base = GRID_HEADER + GRID_TRACK_STRIDE;
        assert_eq!(grid_item_columns(&g, place_base, 0, 5), (Some(4), 1)); // -2 is the second line from the end
        assert_eq!(grid_item_columns(&g, place_base, 0, 2), (Some(1), 1)); // …a different column in a shorter list
        assert_eq!(grid_item_columns(&g, place_base, 1, 5), (Some(0), 5)); // 1 / -1 is every column there is
        assert_eq!(grid_item_columns(&g, place_base, 1, 2), (Some(0), 2));
        assert_eq!(grid_item_columns(&g, place_base, 2, 5), (Some(1), 3)); // an end-side span keeps its start line
        assert_eq!(grid_item_columns(&g, place_base, 3, 5), (None, 1)); // a line past the end auto-places
    }
}
