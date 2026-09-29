// The layout WALK in Rust: the arena and the style engine's computed values turned into the records the layout pass
// reads (`layout::Input`, its runs and their texts) — what layout.js's `nlShadowRun` builds from the JS cascade, built
// here from stylo's, with no V8 crossing per element. Step 3 of the native pipeline: one native path from style to
// layout.
//
// It produces the SAME records, and that is the contract while the JS walk still exists: the parity instrument
// (`CSIM_WALK_PARITY=1`) builds from every pass root the JS walk laid out and compares the two field by field. So the
// JS walk's MODEL rules are this walk's too, ported as they stand — a line height rounded to whole px, a baseline
// floored within its line box, a face bucketed to regular / bold × italic — where the VALUES come from stylo: a
// difference there is the two style systems disagreeing (stylo's lengths are f32; it snaps a border width), which the
// instrument tallies apart from a record the walks built differently.
//
// It builds only what it has been taught, and DECLINES the rest by name — a percentage, a float, a positioned box,
// inline elements, a replaced element, generated content, a shadow tree — as the JS walk declines what native cannot
// lay out: the JS walk then lays the page out as before. It mirrors that walk's FLIP mode, where every branch that
// would read the JS layout's own boxes (a pushed size, a replayed box, a percentage resolved against the JS layout's
// basis) declines the pass instead: so a shape it takes is one whose records say only what the page declares.

use std::collections::HashMap;

use style::computed_values::{
    box_sizing::T as BoxSizing, clear::T as Clear, direction::T as Direction, float::T as Float, hyphens::T as Hyphens,
    overflow_wrap::T as OverflowWrap, position::T as Position, text_align::T as TextAlign,
    white_space_collapse::T as WhiteSpaceCollapse, word_break::T as WordBreak,
};
use style::properties::ComputedValues;
use style::servo_arc::Arc;
use style::values::computed::{Length, LengthPercentage};
use style::values::specified::box_::Overflow;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::layout::{MATH_DEPTH, MATH_LINE, MATH_MAX, MATH_MIN, MATH_NEG, MATH_SCALE, MATH_SUM};
use crate::layout::{InlineBox, Input, Run, RunText, DISPLAY_BLOCK, DISPLAY_TEXT_BLOCK, RUN_BR, RUN_CLOSE, RUN_FLOAT, RUN_OOF, RUN_OPEN, RUN_TEXT, RUN_WBR};

// A face the walk measures a run in, as the JS side resolved it for the family and the weight / style bucket: the
// layout's font handle and the metrics the model rules read off it (per em — ascent, descent, line gap, and the
// advance of a space, or the face's average where it has none).
#[derive(Clone, Copy)]
pub(crate) struct Face {
    pub(crate) handle: i32,
    pub(crate) asc: f64,
    pub(crate) desc: f64,
    pub(crate) gap: f64,
    pub(crate) space: f64,
}

// Which face: the family list as the computed value serializes it, and the JS walk's bucket (`''`, `bold`, `italic`,
// `bold:italic`).
pub(crate) type FaceKey = (String, &'static str);

// The faces a walk has been told of, and the ones it asked for and was not — which it names by declining with
// `Outcome::NeedsFaces`, for the caller to resolve and walk again. None is a face the family does not resolve to.
#[derive(Default)]
pub(crate) struct Faces {
    known: HashMap<FaceKey, Option<Face>>,
    pub(crate) missing: Vec<FaceKey>,
    // The generation the faces were resolved at (`natFontGen`: the rules and the FontFaceSet a family resolves by).
    generation: String,
}

impl Faces {
    pub(crate) fn learn(&mut self, key: FaceKey, face: Option<Face>) {
        self.known.insert(key, face);
    }
    // Forget every face once what they resolve by has moved.
    pub(crate) fn at_generation(&mut self, generation: &str) {
        if self.generation != generation {
            self.known.clear();
            self.generation = generation.to_owned();
        }
    }
}

// What a walk hands the layout pass: its records, its runs and their texts, and the math table its programs are in.
pub(crate) struct Built {
    pub(crate) inputs: Vec<Input>,
    pub(crate) runs: Vec<Run>,
    pub(crate) run_texts: Vec<RunText>,
    pub(crate) inlines: Vec<InlineBox>,
    pub(crate) maths: Vec<f64>,
}

// The pass root's containing block, which a percentage in the ROOT's own record resolves against: the viewport, for the
// page's root element.
#[derive(Clone, Copy)]
pub(crate) struct Basis {
    pub(crate) w: f64,
    pub(crate) h: f64,
}

pub(crate) enum Outcome {
    Built(Built),
    Declined(&'static str),
    NeedsFaces,
}

// Walk the subtree at `root` — the element the JS walk took as its pass root.
pub(crate) fn build(arena: &RealmArena, root: NodeId, basis: Basis, faces: &mut Faces) -> Outcome {
    faces.missing.clear();
    let mut walk = Walk {
        arena,
        faces,
        basis,
        inputs: Vec::new(),
        runs: Vec::new(),
        run_texts: Vec::new(),
        maths: Vec::new(),
        math_index: HashMap::new(),
        inlines: Vec::new(),
        entries: Vec::new(),
        rec_index: HashMap::new(),
        saw_float: (false, false),
    };
    let done = walk.root(root);
    if !walk.faces.missing.is_empty() {
        return Outcome::NeedsFaces;
    }
    match done {
        Ok(()) => Outcome::Built(Built {
            inputs: walk.inputs,
            runs: walk.runs,
            run_texts: walk.run_texts,
            inlines: walk.inlines,
            maths: walk.maths,
        }),
        Err(why) => Outcome::Declined(why),
    }
}

type Step = Result<(), &'static str>;

struct Walk<'a> {
    arena: &'a RealmArena,
    faces: &'a mut Faces,
    basis: Basis,
    inputs: Vec<Input>,
    runs: Vec<Run>,
    run_texts: Vec<RunText>,
    // The programs the records name, each once (`[length, op, a, b, …]` at its offset), and where each one is.
    maths: Vec<f64>,
    math_index: HashMap<Vec<u64>, u32>,
    // The inline table (`InlineBox` per inline box the runs open, in the order they open them), and the entries the
    // gathers made, which a text block tables when its runs are committed.
    inlines: Vec<InlineBox>,
    entries: Vec<InlineBox>,
    // Each element's record, for an out-of-flow box to name its containing block by.
    rec_index: HashMap<NodeId, i32>,
    // Whether a float has been placed on the left / right in the formatting context the walk is in.
    saw_float: (bool, bool),
}

// What `record_as` settles about a box before its record is built (`walkFresh`): its `clear` (0 none, 1 left, 2
// right, 3 both), whether that gives it clearance, which side it floats to (0 none, 1 left, 2 right), and whether it
// establishes a formatting context.
struct Fresh {
    clear: u8,
    separates: bool,
    floated: u8,
    bfc: bool,
}

// What a block's element child is to its flow.
#[derive(Clone, Copy, PartialEq)]
enum Kid {
    Block,
    Float,
    OutOfFlow,
}

// Where the streams stood, for an attempt to be taken back to.
#[derive(Clone, Copy)]
struct Mark {
    inputs: usize,
    runs: usize,
    entries: usize,
    inlines: usize,
}

// A text block's inline content as its gather builds it (`nlGatherRuns`'s `ctx`): the block's style (its tab stops,
// what an inline's font is taken against), whether its indent can bite, the runs so far, and whether any of them
// makes a line.
struct Gather<'s> {
    block: &'s ComputedValues,
    // (…the text block's record, which an out-of-flow box among the lines hangs under)
    idx: i32,
    bites: bool,
    runs: Vec<Pending>,
    makes_line: bool,
    // (…the floats among them, which an anonymous run that makes no line hands back to its block)
    floats: Vec<NodeId>,
}

// A run before its block commits it: its inline box is named by the gather's entry, tabled at the commit.
enum Pending {
    Text { font: FontInfo, text: Vec<u16>, wrap: u8, ws: u8 },
    Open { plain: f64, ws: u8, entry: usize },
    Close { plain: f64, ws: u8, entry: usize, lands: bool, own_h: f64, own_asc: f64 },
    Br { ws: u8, clear: u8, entry: usize },
    Wbr { ws: u8, entry: usize },
    // An out-of-flow box's static position: where the flow reached it, on this line.
    Oof { ws: u8, rec: i32 },
    // A float, placed where the lines reach it.
    Float { ws: u8, rec: i32 },
}

// An inline box's edges as its entry and its runs carry them (`edgeInsets` + `nlEdgeParts` / `nlClampedEdgeParts`,
// arranged by `nlInlineEntry`): the margins, the border + padding sides, the borders, each side's fraction of the
// block's width, each side's program in the table's order (ml, left, right, mr, top, bottom), and the four horizontal
// ones at NO basis.
#[derive(Default)]
struct Edges {
    ml: f64,
    mr: f64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    bt: f64,
    br: f64,
    bb: f64,
    bl: f64,
    f_ml: f64,
    f_left: f64,
    f_right: f64,
    f_mr: f64,
    f_top: f64,
    f_bottom: f64,
    math: [Option<Vec<f64>>; 6],
    plain_ml: f64,
    plain_left: f64,
    plain_right: f64,
    plain_mr: f64,
}

impl Edges {
    fn of(style: &ComputedValues) -> Result<Edges, &'static str> {
        let (edges, _) = edge_lps(style)?;
        let [bt, br, bb, bl] = used_borders(style);
        let parts = if !edges.iter().flatten().any(|lp| lp.has_percentage()) {
            EdgeParts::at(&edges, 0.0)?
        } else {
            EdgeParts::linear(&edges)?.map_or_else(|| EdgeParts::clamped(&edges), Ok)?
        };
        let bare = |k: usize| match edges[k] {
            Some(lp) if !lp.has_percentage() => length(lp).map(|v| if k >= 4 { v.max(0.0) } else { v }),
            _ => Ok(0.0),
        };
        // (…a padding's program carries its border back in, as the table's sides are border + padding.)
        let side = |k: usize, border: f64| {
            parts.prog[k].as_ref().map(|prog| {
                let mut prog = prog.clone();
                if border != 0.0 {
                    prog.extend([MATH_LINE, border, 0.0, MATH_SUM, 0.0, 0.0]);
                }
                prog
            })
        };
        Ok(Edges {
            ml: parts.px[3],
            mr: parts.px[1],
            left: parts.px[7] + bl,
            right: parts.px[5] + br,
            top: parts.px[4] + bt,
            bottom: parts.px[6] + bb,
            bt,
            br,
            bb,
            bl,
            f_ml: parts.frac[3],
            f_left: parts.frac[7],
            f_right: parts.frac[5],
            f_mr: parts.frac[1],
            f_top: parts.frac[4],
            f_bottom: parts.frac[6],
            math: [side(3, 0.0), side(7, bl), side(5, br), side(1, 0.0), side(4, bt), side(6, bb)],
            plain_ml: bare(3)?,
            plain_left: bare(7)? + bl,
            plain_right: bare(5)? + br,
            plain_mr: bare(1)?,
        })
    }
}

// A block's font as its runs and its line box take it (`nlFontInfo`).
#[derive(Clone, Copy, PartialEq)]
struct FontInfo {
    face: i32,
    size: f64,
    ls: f64,
    ws: f64,
    lh: f64,
    asc: f64,
    tab_px: f64,
    tab_min: f64,
}

// The white-space modes a record and a run carry (layout.js `WS_MODE`).
const WS_NORMAL: u8 = 0;
const WS_NOWRAP: u8 = 1;
const WS_PRE: u8 = 2;
const WS_PRE_WRAP: u8 = 3;
const WS_PRE_LINE: u8 = 4;
const WS_BREAK_SPACES: u8 = 5;

// The elements HTML gives a formatting context of their own whatever their `display` (layout.js `OWN_CONTEXT_TAGS`:
// the widgets and the replaced elements).
const OWN_CONTEXT_TAGS: &[&str] = &[
    "button", "input", "select", "textarea", "fieldset", "meter", "progress", "marquee", "img", "canvas", "video", "audio",
    "object", "embed", "iframe", "frame", "svg",
];
// …and the ones this walk declines for now, each sized or laid out from what it has not been taught: the replaced
// elements and the controls (their intrinsic size is data or UA rules, `intrinsicSize`), a fieldset (its legend and
// its anonymous content box), a `<details>` (the content its closed state hides).
fn declined_tag(tag: &str) -> Option<&'static str> {
    match tag {
        "input" | "select" | "textarea" | "button" | "meter" | "progress" | "img" | "canvas" | "video" | "audio" | "object"
        | "embed" | "iframe" | "frame" | "svg" => Some("replaced or control"),
        "fieldset" => Some("fieldset"),
        "details" => Some("details"),
        _ => None,
    }
}

impl<'a> Walk<'a> {
    fn root(&mut self, root: NodeId) -> Step {
        let style = self.style(root)?;
        let b = style.get_box();
        if matches!(b.clone_position(), Position::Absolute | Position::Fixed) || b.clone_float() != Float::None {
            return Err("root unsupported");
        }
        self.record(root, -1)
    }

    // The offset of `prog` in the pass's math table, entered once; NO_MATH for none.
    fn math(&mut self, prog: Option<&[f64]>) -> u32 {
        let Some(prog) = prog else { return crate::layout::NO_MATH };
        let key: Vec<u64> = prog.iter().map(|v| v.to_bits()).collect();
        if let Some(&at) = self.math_index.get(&key) {
            return at;
        }
        let at = self.maths.len() as u32;
        self.maths.push((prog.len() / 3) as f64);
        self.maths.extend_from_slice(prog);
        self.math_index.insert(key, at);
        at
    }

    fn style(&self, id: NodeId) -> Result<Arc<ComputedValues>, &'static str> {
        crate::style::primary_style(self.arena, id).ok_or("unstyled")
    }

    fn node(&self, id: NodeId) -> &'a crate::dom::NodeData {
        self.arena.get(id).expect("a walked node is live")
    }

    // The element's children the flow lays out, in order — the DOM's, since this walk declines a shadow tree, a slot
    // and a box-less `display: contents` element (`layoutChildren` looks through them).
    fn children(&self, id: NodeId) -> impl Iterator<Item = NodeId> + 'a {
        let arena = self.arena;
        self.node(id).children.iter().copied().filter(move |&c| arena.get(c).is_some())
    }

    // One element's record, and its subtree's (`walkRecord`) — an in-flow box's, or an out-of-flow one's that `oof`
    // emits.
    fn record(&mut self, id: NodeId, parent: i32) -> Step {
        self.record_as(id, parent, false)
    }
    fn record_as(&mut self, id: NodeId, parent: i32, out_of_flow: bool) -> Step {
        // Whether a float is already placed in the formatting context this box is in, per side, is the walk's own
        // document-order state (`walkFresh`): a box whose `clear` names such a side has CLEARANCE, and does not
        // collapse its top margin with its parent's (§8.3.1). A float marks its side; a box that establishes a
        // formatting context shows its content none of the floats around it.
        let style = self.style(id)?;
        let clear = self.clear_code(id, &style)?;
        let separates = match clear {
            1 => self.saw_float.0,
            2 => self.saw_float.1,
            3 => self.saw_float.0 || self.saw_float.1,
            _ => false,
        };
        let floated = self.float_code(id, &style)?;
        match floated {
            1 => self.saw_float.0 = true,
            2 => self.saw_float.1 = true,
            _ => {}
        }
        let bfc = self.establishes_bfc(id, &style);
        let outer = self.saw_float;
        if bfc {
            self.saw_float = (false, false);
        }
        let done = self.record_body(id, parent, out_of_flow, Fresh { clear, separates, floated, bfc });
        if bfc {
            self.saw_float = outer;
        }
        done
    }
    fn record_body(&mut self, id: NodeId, parent: i32, out_of_flow: bool, fresh: Fresh) -> Step {
        let node = self.node(id);
        let style = self.style(id)?;
        let tag: &str = &node.local_name;
        if !node.is_html() {
            return Err("foreign element");
        }
        if let Some(why) = declined_tag(tag) {
            return Err(why);
        }
        if node.shadow_root.is_some() || tag == "slot" {
            return Err("shadow tree");
        }
        if self.generates_content(id) {
            return Err("generated content");
        }
        let b = style.get_box();
        let display = b.clone_display();
        if !matches!(display.outside(), DisplayOutside::Block) || !matches!(display.inside(), DisplayInside::Flow | DisplayInside::FlowRoot) {
            return Err(display_decline(display));
        }
        let position = b.clone_position();
        if matches!(position, Position::Absolute | Position::Fixed) != out_of_flow {
            return Err("positioned");
        }
        if !style.writing_mode.is_horizontal() {
            return Err("vertical writing mode");
        }
        let idx = self.inputs.len() as i32;
        let mut rec = fresh_record();
        rec.nid = id.to_f64();
        rec.parent = parent;
        rec.run_start = -1;
        rec.flex_shrink = 1.0;
        let pos = style.get_position();
        rec.border_box = pos.box_sizing == BoxSizing::BorderBox;
        rec.decl_border_box = rec.border_box;
        // The six sizes: a length as itself; one with a percentage in it resolved here against the pass root's
        // containing block where the record is the ROOT's (native is handed no basis for it), and anywhere else
        // handed to native as the pair — or the program — it resolves at the basis it has (`walkRecord`'s `size`).
        let native_basis = parent >= 0;
        use style::values::generics::length::GenericSize as Size;
        if !matches!(pos.width, Size::Auto | Size::LengthPercentage(_)) {
            return Err("width keyword");
        }
        let sizes: [(Option<&LengthPercentage>, f64); 6] = [
            (size_lp(&pos.width)?, self.basis.w),
            (size_lp(&pos.height)?, self.basis.h),
            (size_lp(&pos.min_width)?, self.basis.w),
            (max_size_lp(&pos.max_width)?, self.basis.w),
            (size_lp(&pos.min_height)?, self.basis.h),
            (max_size_lp(&pos.max_height)?, self.basis.h),
        ];
        let mut slots = [f64::NAN; 6];
        for (k, (lp, basis)) in sizes.iter().enumerate() {
            let Some(lp) = lp else { continue };
            if !lp.has_percentage() {
                slots[k] = length(lp)?;
            } else if !native_basis {
                if basis.is_nan() {
                    return Err("root basis");
                }
                slots[k] = at(lp, *basis)?.max(0.0);
            } else {
                let spec = spec(lp)?;
                rec.pct_sizes[k] = spec.frac;
                rec.pct_px[k] = spec.px;
                rec.pct_math[k] = self.math(spec.prog.as_deref());
            }
        }
        [rec.width, rec.height, rec.min_w, rec.max_w, rec.min_h, rec.max_h] = slots;
        // (…the DECLARED inline sizing, which has no basis at all: a percentage in it is none, `auto`.)
        let declared = |k: usize| sizes[k].0.filter(|lp| !lp.has_percentage()).map_or(Ok(f64::NAN), |lp| length(lp));
        rec.decl_w = declared(0)?;
        rec.decl_min_w = declared(2)?;
        rec.decl_max_w = declared(3)?;
        rec.pct_h_decl = [1, 4, 5].iter().any(|&k| sizes[k].0.is_some_and(|lp| lp.has_percentage()))
            || (position == Position::Relative && [&pos.top, &pos.bottom].iter().any(|i| inset_lp(i).ok().flatten().is_some_and(|lp| lp.has_percentage())));
        // The margins and padding, likewise — against the containing block's WIDTH, all eight.
        let (edges, auto) = edge_lps(&style)?;
        rec.auto_margins = auto;
        let parts = if !edges.iter().flatten().any(|lp| lp.has_percentage()) {
            EdgeParts::at(&edges, 0.0)?
        } else if !native_basis {
            if self.basis.w.is_nan() {
                return Err("root basis");
            }
            EdgeParts::at(&edges, self.basis.w)?
        } else {
            EdgeParts::linear(&edges)?.map_or_else(|| EdgeParts::clamped(&edges), Ok)?
        };
        [rec.mt, rec.mr, rec.mb, rec.ml, rec.pt, rec.pr, rec.pb, rec.pl] = parts.px;
        rec.edge_px = parts.px;
        rec.edge_frac = parts.frac;
        for k in 0..8 {
            rec.edge_math[k] = self.math(parts.prog[k].as_deref());
        }
        [rec.bt, rec.br, rec.bb, rec.bl] = used_borders(&style);
        // (…and the horizontal ones at NO basis, what an intrinsic measure reads: a percentage in them is none.)
        let bare = |lp: Option<&LengthPercentage>, floor: bool| match lp {
            Some(lp) if !lp.has_percentage() => length(lp).map(|v| if floor { v.max(0.0) } else { v }),
            _ => Ok(0.0),
        };
        rec.decl_edges_x = bare(edges[5], true)? + bare(edges[7], true)? + rec.bl + rec.br;
        rec.decl_margin_x = bare(edges[1], false)? + bare(edges[3], false)?;
        rec.height_adjoins = auto_or_zero(&pos.height);
        rec.minh_adjoins = auto_or_zero(&pos.min_height);
        rec.bottom_adjoins = rec.height.is_nan();
        rec.clear = fresh.clear;
        rec.takes_clearance = fresh.separates;
        rec.float_kind = fresh.floated;
        rec.starts_bfc = fresh.bfc;
        let rtl = style.get_inherited_box().direction == Direction::Rtl;
        rec.rtl = rtl as u8;
        rec.scrolls_x = scrolls(b.overflow_x);
        rec.scrolls_y = scrolls(b.overflow_y);
        rec.legacy_align = self.legacy_align(id);
        // `position: relative` is a shift applied after the flow (§9.4.3) — not the pass root's, which is folded into
        // the origin it is handed.
        if parent >= 0 && position == Position::Relative {
            self.relative(&style, &mut rec)?;
        }
        self.inputs.push(rec);
        self.rec_index.insert(id, idx);

        // What the children are to this block's flow: block-level boxes, or inline content (`walkRecord`'s classify).
        let ws_mode = ws_mode_of(&style)?;
        // (…the block-level children and the out-of-flow ones, in document order: an out-of-flow box's static position
        // is where the flow reached it.)
        let mut blocks: Vec<(NodeId, Kid)> = Vec::new();
        let mut in_flow = false;
        let mut inline = false;
        for c in self.children(id) {
            let cn = self.node(c);
            match cn.kind {
                NodeKind::Text => {
                    let child_mode = ws_mode;
                    if has_content(&cn.data) || white_space_only_is_content(&cn.data, child_mode) {
                        inline = true;
                    } else if !cn.data.is_empty() && preserving(child_mode) && indent_may_bite(&style)? {
                        return Err("text-not-measurable");
                    }
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let cb = cs.get_box();
                    let cd = cb.clone_display();
                    if cd.is_none() {
                        continue;
                    }
                    if cd.is_contents() {
                        return Err("display contents");
                    }
                    if matches!(cb.clone_position(), Position::Absolute | Position::Fixed) {
                        blocks.push((c, Kid::OutOfFlow));
                        continue;
                    }
                    if cb.clone_float() != Float::None {
                        blocks.push((c, Kid::Float));
                        continue;
                    }
                    if matches!(cd.outside(), DisplayOutside::Inline) {
                        inline = true;
                        continue;
                    }
                    blocks.push((c, Kid::Block));
                    in_flow = true;
                }
                _ => {}
            }
        }
        if inline && in_flow {
            return self.mixed_block(id, idx, &style, ws_mode, &blocks);
        }
        if inline {
            return self.text_block(id, idx, &style, ws_mode);
        }
        self.inputs[idx as usize].display = DISPLAY_BLOCK;
        self.inputs[idx as usize].ws_mode = ws_mode;
        // The cursor an out-of-flow child reads is a LINE cursor: the block's first-line indent and its line height.
        if blocks.iter().any(|&(_, kid)| kid == Kid::OutOfFlow) {
            let (indent, bits) = indent(&style)?;
            let math = self.math(indent.prog.as_deref());
            let lh = self.font_info(&style, &style)?.lh;
            let rec = &mut self.inputs[idx as usize];
            rec.indent_px = indent.px;
            rec.indent_frac = indent.frac;
            rec.indent_math = math;
            rec.indent_hanging = bits & 256 != 0;
            rec.indent_each_line = bits & 512 != 0;
            rec.strut_lh = lh;
        }
        for (c, kid) in blocks {
            if kid == Kid::OutOfFlow {
                self.out_of_flow(c, idx)?;
            } else {
                self.record(c, idx)?;
            }
        }
        Ok(())
    }

    // A block holding BOTH block-level boxes and inline content (§9.2.1.1): each maximal run of inline content is an
    // ANONYMOUS block of lines — a record of no element (nid −1) — among the block children in document order. Floats
    // and out-of-flow boxes join the run they are written in, as markers on its lines. A run that makes no line is
    // no box: its records are taken back, and its floats go where the next line would have started — among the
    // block's own children.
    fn mixed_block(&mut self, id: NodeId, idx: i32, style: &ComputedValues, ws_mode: u8, blocks: &[(NodeId, Kid)]) -> Step {
        let font = self.font_info(style, style)?;
        let (indent, bits) = indent(style)?;
        let bites = indent.px != 0.0 || indent.frac != 0.0 || indent.prog.is_some();
        let starts_at_right = style.get_inherited_box().direction == Direction::Rtl;
        let align = align_code(style.get_inherited_text().text_align, starts_at_right);
        let wrap = wrap_mode(style);
        self.inputs[idx as usize].display = DISPLAY_BLOCK;
        self.inputs[idx as usize].ws_mode = ws_mode;
        let block_kids: Vec<NodeId> = blocks.iter().filter(|&&(_, kid)| kid == Kid::Block).map(|&(c, _)| c).collect();
        let mut unspent = true;
        let mut group: Vec<NodeId> = Vec::new();
        let children: Vec<NodeId> = self.children(id).collect();
        for c in children.into_iter().chain(std::iter::once(id)) {
            let end = c == id;
            let is_block = !end && block_kids.contains(&c);
            if !end && !is_block {
                let n = self.node(c);
                if n.kind == NodeKind::Element && self.style(c)?.get_box().clone_display().is_none() {
                    continue;
                }
                if matches!(n.kind, NodeKind::Text | NodeKind::Element) {
                    group.push(c);
                }
                continue;
            }
            // (…the white space between block children, the commonest run there is, is none without an attempt)
            let kids = std::mem::take(&mut group);
            let only_space = kids.iter().all(|&k| {
                let n = self.node(k);
                n.kind == NodeKind::Text && !has_content(&n.data) && !white_space_only_is_content(&n.data, ws_mode)
            });
            if !kids.is_empty() && !only_space {
                let mark = self.mark();
                let anon = self.inputs.len() as i32;
                let mut rec = fresh_record();
                rec.nid = -1.0;
                rec.parent = idx;
                rec.display = DISPLAY_TEXT_BLOCK;
                self.inputs.push(rec);
                let mut g = Gather { block: style, idx: anon, bites, runs: Vec::new(), makes_line: false, floats: Vec::new() };
                self.gather(&kids, style, &font, ws_mode, wrap, &mut g)?;
                let holds_oof = g.runs.iter().any(|r| matches!(r, Pending::Oof { .. }));
                let occupies = g.runs.iter().any(|r| matches!(r, Pending::Open { .. } | Pending::Wbr { .. }));
                if !g.makes_line && !occupies && !holds_oof {
                    let floats: Vec<NodeId> = g.floats.clone();
                    self.rollback(mark);
                    for f in floats {
                        self.record(f, idx)?;
                    }
                } else {
                    let math = self.math(indent.prog.as_deref());
                    let parent = self.inputs[idx as usize];
                    let r = &mut self.inputs[anon as usize];
                    [r.width, r.height, r.min_w, r.max_w, r.min_h, r.max_h] = [f64::NAN; 6];
                    r.height_adjoins = true;
                    r.minh_adjoins = true;
                    r.strut_lh = font.lh;
                    r.strut_asc = font.asc;
                    r.ws_mode = ws_mode;
                    r.indent_px = indent.px;
                    r.indent_frac = indent.frac;
                    r.indent_math = math;
                    r.indent_hanging = bits & 256 != 0;
                    r.indent_each_line = bits & 512 != 0;
                    // (…a block with no indent writes none of it, the `spent` bit included: `nlWriteIndent`)
                    r.indent_spent = !unspent && (bites || bits != 0);
                    unspent = false;
                    r.rtl = parent.rtl;
                    r.block_axis_is_x = parent.block_axis_is_x;
                    r.text_align = align;
                    r.anon_group = true;
                    self.commit(anon, g);
                }
            }
            if is_block {
                unspent = false;
                self.record(c, idx)?;
            }
        }
        Ok(())
    }

    // Where the streams stand, to take an attempt back to.
    fn mark(&self) -> Mark {
        Mark { inputs: self.inputs.len(), runs: self.runs.len(), entries: self.entries.len(), inlines: self.inlines.len() }
    }
    fn rollback(&mut self, m: Mark) {
        self.inputs.truncate(m.inputs);
        self.runs.truncate(m.runs);
        self.run_texts.truncate(m.runs);
        self.entries.truncate(m.entries);
        self.inlines.truncate(m.inlines);
        self.rec_index.retain(|_, &mut at| (at as usize) < m.inputs);
    }

    // An OUT-OF-FLOW child of the container at record `parent` (`emitOutOfFlow`): its own record subtree, marked out of
    // flow and naming its CONTAINING BLOCK — a record of this pass by index, else the viewport's rectangle — with its
    // insets for native to resolve against that block's padding box. Its record index.
    fn out_of_flow(&mut self, id: NodeId, parent: i32) -> Result<i32, &'static str> {
        let style = self.style(id)?;
        let fixed = style.get_box().clone_position() == Position::Fixed;
        let cb = self.containing_block(id, fixed)?;
        let at = self.inputs.len() as i32;
        self.record_as(id, parent, true)?;
        let mut insets = [(f64::NAN, 0.0, crate::layout::NO_MATH); 4];
        let pos = style.get_position();
        for (k, inset) in [&pos.top, &pos.right, &pos.bottom, &pos.left].into_iter().enumerate() {
            if let Some(lp) = inset_lp(inset)? {
                let s = spec(lp)?;
                insets[k] = (s.px, s.frac, self.math(s.prog.as_deref()));
            }
        }
        let r = &mut self.inputs[at as usize];
        r.out_of_flow = 1;
        r.item_auto_height = false;
        match cb {
            Some(cb) => r.cb_index = self.rec_index[&cb],
            None => {
                r.cb_index = crate::layout::CB_RECT;
                r.cb_rect = [0.0, 0.0, self.basis.w, self.basis.h];
            }
        }
        [r.inset_top, r.inset_right, r.inset_bottom, r.inset_left] = insets.map(|i| i.0);
        r.inset_frac = insets.map(|i| i.1);
        r.inset_math = insets.map(|i| i.2);
        r.flex_cross_align = 0;
        r.rel_x = 0.0;
        r.rel_y = 0.0;
        Ok(at)
    }

    // The element an out-of-flow box's insets measure against (`nlContainingBlockElement`): the nearest positioned
    // ancestor — a fixed one's only where a transform, a filter or containment makes one its containing block — the
    // root element never; None for the viewport. One outside this pass's records is declined.
    fn containing_block(&self, id: NodeId, fixed: bool) -> Result<Option<NodeId>, &'static str> {
        let mut cur = self.node(id).parent;
        while let Some(p) = cur {
            let node = self.node(p);
            if node.kind != NodeKind::Element {
                break;
            }
            let is_root = node.parent.and_then(|d| self.arena.get(d)).is_some_and(|d| d.kind == NodeKind::Document);
            if is_root {
                break;
            }
            let ps = self.style(p)?;
            let pd = ps.get_box().clone_display();
            if !pd.is_none() && !pd.is_contents() && ((!fixed && ps.get_box().clone_position() != Position::Static) || contains_out_of_flow(&ps, node)) {
                if matches!(pd.outside(), DisplayOutside::Inline) && matches!(pd.inside(), DisplayInside::Flow) {
                    return Err("inline containing block");
                }
                return if self.rec_index.contains_key(&p) { Ok(Some(p)) } else { Err("containingBlockBox") };
            }
            cur = node.parent;
        }
        Ok(None)
    }

    // A relative box's offset (`relativeOffset`), or — where a percentage is in an inset — the pairs and programs
    // native resolves against the containing block (`nlRelativeSpec`): `left`, else `right` negated (both set, the
    // box's own direction drops one), and `top` beside `bottom`, which native chooses between once it knows whether
    // the height is definite.
    fn relative(&mut self, style: &ComputedValues, rec: &mut Input) -> Step {
        let pos = style.get_position();
        let [top, right, bottom, left] = [inset_lp(&pos.top)?, inset_lp(&pos.right)?, inset_lp(&pos.bottom)?, inset_lp(&pos.left)?];
        let rtl = style.get_inherited_box().direction == Direction::Rtl;
        let keep_right = right.is_some() && (left.is_none() || rtl);
        if ![top, right, bottom, left].iter().flatten().any(|lp| lp.has_percentage()) {
            let px = |lp: Option<&LengthPercentage>| lp.map_or(Ok(0.0), length);
            rec.rel_x = if keep_right { -px(right)? } else { px(left)? };
            rec.rel_y = if top.is_some() { px(top)? } else { -px(bottom)? };
            // (…which the record also carries as the base the pairs resolve onto: `rel_pct[5..6]` are rec[39..40])
            rec.rel_pct[5] = rec.rel_x;
            rec.rel_pct[6] = rec.rel_y;
            return Ok(());
        }
        let x = if keep_right { right } else { left };
        let xs = x.map(spec).transpose()?;
        rec.rel_x_px = xs.as_ref().map_or(0.0, |s| s.px);
        // (…a fraction that is no percentage at all rides as nothing: 0 across, NaN down, where it is what makes an
        // indefinite height's `top` fall back to `bottom`.)
        rec.rel_pct[0] = match (x, &xs) {
            (Some(lp), Some(s)) if lp.has_percentage() => s.frac,
            _ => 0.0,
        };
        rec.rel_x_neg = keep_right;
        let vertical = |lp: Option<&LengthPercentage>| -> Result<(f64, f64, Option<Vec<f64>>), &'static str> {
            Ok(match lp {
                None => (f64::NAN, f64::NAN, None),
                Some(lp) => {
                    let s = spec(lp)?;
                    (if lp.has_percentage() { s.frac } else { f64::NAN }, s.px, s.prog)
                }
            })
        };
        let (tf, tp, tprog) = vertical(top)?;
        let (bf, bp, bprog) = vertical(bottom)?;
        rec.rel_pct[1] = tf;
        rec.rel_pct[2] = tp;
        rec.rel_pct[3] = bf;
        rec.rel_pct[4] = bp;
        rec.rel_math = [self.math(xs.as_ref().and_then(|s| s.prog.as_deref())), self.math(tprog.as_deref()), self.math(bprog.as_deref())];
        Ok(())
    }

    // A block of inline content — text and inline boxes — laid out in lines (`walkRecord`'s text-block arm).
    fn text_block(&mut self, id: NodeId, idx: i32, style: &ComputedValues, ws_mode: u8) -> Step {
        let (indent, indent_bits) = indent(style)?;
        let bites = indent.px != 0.0 || indent.frac != 0.0 || indent.prog.is_some();
        let indent_math = self.math(indent.prog.as_deref());
        let font = self.font_info(style, style)?;
        let starts_at_right = style.get_inherited_box().direction == Direction::Rtl;
        let align = align_code(style.get_inherited_text().text_align, starts_at_right);
        let mut g = Gather { block: style, idx, bites, runs: Vec::new(), makes_line: false, floats: Vec::new() };
        let kids: Vec<NodeId> = self.children(id).collect();
        self.gather(&kids, style, &font, ws_mode, wrap_mode(style), &mut g)?;
        // (…the indent and the alignment written before the gather, as the JS walk writes them: a block whose content
        // makes no line keeps them too.)
        let rec = &mut self.inputs[idx as usize];
        rec.indent_px = indent.px;
        rec.indent_frac = indent.frac;
        rec.indent_math = indent_math;
        rec.indent_hanging = indent_bits & 256 != 0;
        rec.indent_each_line = indent_bits & 512 != 0;
        rec.text_align = align;
        rec.ws_mode = ws_mode;
        // Only white space: an empty block — unless an inline box or a `<wbr>` occupies a line, where a first-line
        // indent is taken (`nlRunsOccupyALine`).
        if !g.makes_line && !g.runs.iter().any(|r| matches!(r, Pending::Open { .. } | Pending::Wbr { .. })) {
            rec.display = DISPLAY_BLOCK;
            return Ok(());
        }
        rec.display = DISPLAY_TEXT_BLOCK;
        rec.strut_lh = font.lh;
        rec.strut_asc = font.asc;
        self.commit(idx, g);
        Ok(())
    }

    // A block of lines' runs onto the streams, its inline boxes tabled in the order its runs open them
    // (`commitInlines`), and onto its record.
    fn commit(&mut self, idx: i32, g: Gather) {
        let rec = &mut self.inputs[idx as usize];
        rec.run_start = self.runs.len() as i32;
        rec.run_count = g.runs.len() as i32;
        let mut table: Vec<Option<usize>> = Vec::new();
        for r in g.runs {
            let run = match r {
                Pending::Text { font, text, wrap, ws } => {
                    self.run_texts.push(Some(text.into()));
                    Run {
                        kind: RUN_TEXT,
                        font: font.face,
                        size: font.size,
                        ls: font.ls,
                        ws: font.ws,
                        line_height: font.lh,
                        asc: font.asc,
                        metric: wrap as f64,
                        ws_mode: ws,
                        tab_px: font.tab_px,
                        tab_min: font.tab_min,
                        line_mode: 0,
                        lands: false,
                        plain: 0.0,
                    }
                }
                Pending::Open { plain, ws, entry } => {
                    self.run_texts.push(None);
                    let at = self.inline(entry, &mut table);
                    edge_run(RUN_OPEN, at, plain, ws)
                }
                Pending::Close { plain, ws, entry, lands, own_h, own_asc } => {
                    self.run_texts.push(None);
                    let at = table[entry].expect("a CLOSE follows its OPEN");
                    Run { lands, line_height: own_h, asc: own_asc, ..edge_run(RUN_CLOSE, at, plain, ws) }
                }
                Pending::Br { ws, clear, entry } => {
                    self.run_texts.push(None);
                    let at = self.inline(entry, &mut table);
                    Run { metric: clear as f64, ..edge_run(RUN_BR, at, 0.0, ws) }
                }
                Pending::Wbr { ws, entry } => {
                    self.run_texts.push(None);
                    let at = self.inline(entry, &mut table);
                    edge_run(RUN_WBR, at, 0.0, ws)
                }
                // (…with no relative inline around it to move with, and no programs for one)
                Pending::Oof { ws, rec } => {
                    self.run_texts.push(None);
                    Run { tab_px: f64::NAN, tab_min: f64::NAN, ..edge_run(RUN_OOF, rec as usize, 0.0, ws) }
                }
                Pending::Float { ws, rec } => {
                    self.run_texts.push(None);
                    edge_run(RUN_FLOAT, rec as usize, 0.0, ws)
                }
            };
            self.runs.push(run);
        }
    }

    // An inline box's entry in the pass's inline table, the first time a run names it.
    fn inline(&mut self, entry: usize, table: &mut Vec<Option<usize>>) -> usize {
        if table.len() <= entry {
            table.resize(entry + 1, None);
        }
        *table[entry].get_or_insert_with(|| {
            self.inlines.push(self.entries[entry]);
            self.inlines.len() - 1
        })
    }

    // The runs of `parent`'s children in the inline formatting context `g` builds (`nlGatherRuns`): `owner` the
    // element whose font, `white-space` and wrap mode its text takes — the block, or the inline box it is in.
    fn gather(&mut self, kids: &[NodeId], owner: &ComputedValues, font: &FontInfo, ws_mode: u8, wrap: u8, g: &mut Gather) -> Step {
        let preserve = preserving(ws_mode);
        let no_shy = owner.get_inherited_text().hyphens == Hyphens::None;
        let owner_wraps = ws_mode != WS_NOWRAP && ws_mode != WS_PRE;
        for &c in kids {
            let cn = self.node(c);
            match cn.kind {
                NodeKind::Text => {
                    // (…a preserved CR / FF is text that is not there, and a soft hyphen under `hyphens: none` no
                    // opportunity at all)
                    use std::borrow::Cow;
                    let raw: &[u16] = &cn.data;
                    let stripped: Cow<[u16]> = if preserve && raw.iter().any(|&u| u == 0x0D || u == 0x0C) {
                        Cow::Owned(raw.iter().copied().filter(|&u| u != 0x0D && u != 0x0C).collect())
                    } else {
                        Cow::Borrowed(raw)
                    };
                    let td: Cow<[u16]> = if no_shy && stripped.contains(&0xAD) {
                        Cow::Owned(stripped.iter().copied().filter(|&u| u != 0xAD).collect())
                    } else {
                        stripped.clone()
                    };
                    if td.is_empty() && !raw.is_empty() && g.bites {
                        return Err("text-not-measurable");
                    }
                    if td.is_empty() && !stripped.is_empty() {
                        return Err("text-not-measurable");
                    }
                    if !measurable(&td, wrap) {
                        return Err("text-not-measurable");
                    }
                    if td.is_empty() {
                        continue;
                    }
                    if has_content(&td) || white_space_only_is_content(&td, ws_mode) {
                        g.makes_line = true;
                    }
                    // Adjacent text is one run where it is the same font, shift, wrap and mode, the mode soft-wraps, the
                    // join does not GLUE a word, and neither side of a `pre-line` join is white space alone (`appendText`).
                    if let Some(Pending::Text { font: lf, text, wrap: lw, ws: lws }) = g.runs.last_mut() {
                        let joinable = *lw == wrap
                            && *lws == ws_mode
                            && owner_wraps
                            && same_font(lf, font)
                            && (is_css_ws(*text.last().unwrap()) || is_css_ws(td[0]))
                            && !(ws_mode == WS_PRE_LINE && has_content(text) != has_content(&td));
                        if joinable {
                            text.extend_from_slice(&td);
                            continue;
                        }
                    }
                    g.runs.push(Pending::Text { font: *font, text: td.into_owned(), wrap, ws: ws_mode });
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let b = cs.get_box();
                    let d = b.clone_display();
                    if d.is_none() {
                        continue;
                    }
                    if matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
                        let rec = self.out_of_flow(c, g.idx)?;
                        g.runs.push(Pending::Oof { ws: ws_mode, rec });
                        continue;
                    }
                    if b.clone_float() != Float::None {
                        let rec = self.inputs.len() as i32;
                        self.record(c, g.idx)?;
                        g.runs.push(Pending::Float { ws: ws_mode, rec });
                        g.floats.push(c);
                        continue;
                    }
                    self.inline_child(c, &cs, ws_mode, g)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    // One element in the inline content: a `<br>`, a `<wbr>`, or an inline box around content of its own.
    fn inline_child(&mut self, c: NodeId, cs: &ComputedValues, ws_mode: u8, g: &mut Gather) -> Step {
        let node = self.node(c);
        let tag: &str = &node.local_name;
        if !node.is_html() {
            return Err("foreign element");
        }
        if let Some(why) = declined_tag(tag) {
            return Err(why);
        }
        if node.shadow_root.is_some() || tag == "slot" {
            return Err("shadow tree");
        }
        if self.generates_content(c) {
            return Err("generated content");
        }
        let d = cs.get_box().clone_display();
        if d.is_contents() {
            return Err("display contents");
        }
        if !matches!(d.outside(), DisplayOutside::Inline) {
            return Err("block-level-box-in-inline-content");
        }
        // (…an inline-LEVEL `<br>` breaks the line whatever its inside display: `isLineBreak`)
        if !matches!(d.inside(), DisplayInside::Flow) && tag != "br" {
            return Err("atomic inline");
        }
        if cs.get_box().clone_position() == Position::Relative {
            return Err("relative inline");
        }
        if !baseline_aligned(cs) {
            return Err("vertical-align");
        }
        let cf = self.font_info(cs, g.block)?;
        // A `<br>` breaks the line, clearing the floats on the side it names; a `<wbr>` is a place it may. Each is an
        // inline box of its own with NO edges, whatever it declares (`WBR_EDGES`).
        if tag == "br" || (tag == "wbr" && matches!(d.inside(), DisplayInside::Flow)) {
            let entry = self.entry(cs, &Edges::default())?;
            if tag == "br" {
                let clear = self.clear_code(c, cs)?;
                g.runs.push(Pending::Br { ws: ws_mode, clear, entry });
                g.makes_line = true;
            } else {
                g.runs.push(Pending::Wbr { ws: ws_mode, entry });
            }
            return Ok(());
        }
        // An inline box holding a BLOCK child is laid out as one atomic box, not split around it.
        for k in self.children(c).collect::<Vec<_>>() {
            if self.node(k).kind == NodeKind::Element {
                let ks = self.style(k)?;
                let kd = ks.get_box().clone_display();
                if !kd.is_none() && matches!(kd.outside(), DisplayOutside::Block) && !matches!(ks.get_box().clone_position(), Position::Absolute | Position::Fixed) && ks.get_box().clone_float() == Float::None {
                    return Err("block in inline");
                }
            }
        }
        let c_ws = ws_mode_of(cs)?;
        let c_wrap = wrap_mode(cs);
        // Its edges, and the same with NO basis, which an intrinsic measure reads (`edgeInsets(c, null)`).
        let edges = Edges::of(cs)?;
        let plain_open = edges.plain_ml + edges.plain_left;
        let plain_close = edges.plain_right + edges.plain_mr;
        let varies = |k: usize| edges.math[k].is_some();
        let close_lands = edges.right != 0.0 || edges.mr != 0.0 || edges.f_right != 0.0 || edges.f_mr != 0.0 || varies(2) || varies(3);
        let edged = edges.ml + edges.left != 0.0
            || edges.f_ml + edges.f_left != 0.0
            || varies(0)
            || varies(1)
            || close_lands
            || plain_open != 0.0
            || plain_close != 0.0;
        let entry = self.entry(cs, &edges)?;
        g.runs.push(Pending::Open { plain: if edged { plain_open } else { 0.0 }, ws: c_ws, entry });
        let outer = g.makes_line;
        g.makes_line = false;
        let kids: Vec<NodeId> = self.children(c).collect();
        self.gather(&kids, cs, &cf, c_ws, c_wrap, g)?;
        g.makes_line = outer || g.makes_line || edged;
        let (own_h, own_asc) = if edged && close_lands { (content_height(cs, &self.face(cs)?), content_ascent(cs, &self.face(cs)?)) } else { (0.0, 0.0) };
        g.runs.push(Pending::Close {
            plain: if edged { plain_close } else { 0.0 },
            ws: c_ws,
            entry,
            lands: edged && close_lands,
            own_h,
            own_asc,
        });
        Ok(())
    }

    // An inline box's entry (`nlInlineEntry`): its edges — lengths, fractions and programs — its own font box and
    // ascent, and no relative offset.
    fn entry(&mut self, cs: &ComputedValues, e: &Edges) -> Result<usize, &'static str> {
        let face = self.face(cs)?;
        let math = std::array::from_fn(|k| self.math(e.math[k].as_deref()));
        self.entries.push(InlineBox {
            ml: e.ml,
            right: e.right,
            mr: e.mr,
            top: e.top,
            bottom: e.bottom,
            own_h: content_height(cs, &face),
            own_asc: content_ascent(cs, &face),
            rel_x: 0.0,
            rel_y: 0.0,
            bt: e.bt,
            br: e.br,
            bb: e.bb,
            bl: e.bl,
            f_ml: e.f_ml,
            f_left: e.f_left,
            f_right: e.f_right,
            f_mr: e.f_mr,
            f_top: e.f_top,
            f_bottom: e.f_bottom,
            left: e.left,
            math,
            rel_xf: 0.0,
            rel_yf: 0.0,
            rel_yi: 0.0,
            rel_math: [crate::layout::NO_MATH; 2],
        });
        Ok(self.entries.len() - 1)
    }

    // `owner`'s font as a run takes it, its tab stops counted in `block`'s (`nlFontInfo` / `fontOf` / `lineHeightOf`
    // / `baselineWithin` / `tabStopOf`).
    fn font_info(&mut self, owner: &ComputedValues, block: &ComputedValues) -> Result<FontInfo, &'static str> {
        let face = self.face(owner)?;
        let f = owner.get_font();
        let size = font_size(owner);
        let ls = spacing(&owner.get_inherited_text().letter_spacing.0)?;
        let ws = spacing(&owner.get_inherited_text().word_spacing)?;
        use style::values::generics::font::GenericLineHeight as LineHeight;
        let lh = match &f.line_height {
            LineHeight::Normal => js_round(face.asc * size) + js_round(face.desc * size) + js_round(face.gap * size),
            LineHeight::Number(n) => js_round(n.0 as f64 * size),
            LineHeight::Length(l) => js_round(l.0.px() as f64),
        };
        let asc = ((lh - (js_round(face.asc * size) + js_round(face.desc * size))) / 2.0).floor() + js_round(face.asc * size);
        // The tab stops: the BLOCK's font counts the spaces and gives the half-space minimum, the owner's `tab-size`
        // says how many (`tabStopOf`).
        let block_face = self.face(block)?;
        let bls = spacing(&block.get_inherited_text().letter_spacing.0)?;
        let bws = spacing(&block.get_inherited_text().word_spacing)?;
        let bare = block_face.space * font_size(block);
        let unit_space = bare + bls + bws;
        use style::values::generics::length::GenericLengthOrNumber as LengthOrNumber;
        let raw = match &owner.get_inherited_text().tab_size {
            LengthOrNumber::Number(n) => n.0 as f64 * unit_space,
            LengthOrNumber::Length(l) => l.0.px() as f64,
        };
        let tab = if raw.is_finite() { if raw > 0.0 { raw } else { bls } } else { 8.0 * unit_space };
        Ok(FontInfo { face: face.handle, size, ls, ws, lh, asc, tab_px: tab.max(0.0), tab_min: bare / 2.0 })
    }

    // The face `style`'s font resolves to, as the JS side bucketed and resolved it.
    fn face(&mut self, style: &ComputedValues) -> Result<Face, &'static str> {
        use style_traits::ToCss;
        let f = style.get_font();
        let family = f.font_family.to_css_string();
        let bold = f.font_weight.value() >= 600.0;
        let italic = f.font_style != style::values::computed::font::FontStyle::NORMAL;
        let bucket = match (bold, italic) {
            (false, false) => "",
            (true, false) => "bold",
            (false, true) => "italic",
            (true, true) => "bold:italic",
        };
        let key = (family, bucket);
        match self.faces.known.get(&key) {
            Some(Some(face)) => Ok(*face),
            Some(None) => Err("run-font-not-system"),
            // (…one not asked yet is noted, and the walk goes on with a stand-in, so ONE walk names every face the pass
            // needs: `build` answers NeedsFaces rather than records built with it)
            None => {
                if !self.faces.missing.contains(&key) {
                    self.faces.missing.push(key);
                }
                Ok(Face { handle: -1, asc: 0.0, desc: 0.0, gap: 0.0, space: 0.0 })
            }
        }
    }

    // Does `id` have a `::before` / `::after` that generates a box? (Not laid out here yet.)
    fn generates_content(&self, id: NodeId) -> bool {
        use style::selector_parser::PseudoElement;
        [PseudoElement::Before, PseudoElement::After].iter().any(|pseudo| {
            crate::style::eager_pseudo(self.arena, id, pseudo).is_some_and(|s| {
                !s.get_box().clone_display().is_none() && !matches!(s.get_counters().content, style::values::generics::counters::GenericContent::Normal | style::values::generics::counters::GenericContent::None)
            })
        })
    }

    // The side a box floats to (`floatSide`): 0 none, 1 left, 2 right — a flow-relative one by the direction of the
    // block it is in.
    fn float_code(&self, id: NodeId, style: &ComputedValues) -> Result<u8, &'static str> {
        Ok(match style.get_box().clone_float() {
            Float::None => 0,
            Float::Left => 1,
            Float::Right => 2,
            Float::InlineStart => if self.flow_relative_rtl(id)? { 2 } else { 1 },
            Float::InlineEnd => if self.flow_relative_rtl(id)? { 1 } else { 2 },
        })
    }
    // …and the side it clears (`clearCode`): 0 none, 1 left, 2 right, 3 both.
    fn clear_code(&self, id: NodeId, style: &ComputedValues) -> Result<u8, &'static str> {
        Ok(match style.get_box().clone_clear() {
            Clear::None => 0,
            Clear::Left => 1,
            Clear::Right => 2,
            Clear::Both => 3,
            Clear::InlineStart => if self.flow_relative_rtl(id)? { 2 } else { 1 },
            Clear::InlineEnd => if self.flow_relative_rtl(id)? { 1 } else { 2 },
        })
    }
    // The direction a flow-relative float or clear is read in: the nearest ancestor's that is not an inline box
    // (`flowRelativeRtl`).
    fn flow_relative_rtl(&self, id: NodeId) -> Result<bool, &'static str> {
        let mut cur = self.node(id).parent;
        while let Some(p) = cur {
            let node = self.node(p);
            if node.kind != NodeKind::Element {
                return Ok(false);
            }
            let ps = self.style(p)?;
            let d = ps.get_box().clone_display();
            if !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)) {
                return Ok(ps.get_inherited_box().direction == Direction::Rtl);
            }
            cur = node.parent;
        }
        Ok(false)
    }

    // Does the element establish a block formatting context (`computeEstablishesBFC`)? Asked of a block-level
    // `flow` / `flow-root` box, which is all this walk takes: in flow, floated or out of flow.
    fn establishes_bfc(&self, id: NodeId, style: &ComputedValues) -> bool {
        let node = self.node(id);
        let parent_is_element = node.parent.and_then(|p| self.arena.get(p)).is_some_and(|p| p.kind == NodeKind::Element);
        if !parent_is_element {
            return true;
        }
        if OWN_CONTEXT_TAGS.contains(&&*node.local_name) {
            return true;
        }
        let b = style.get_box();
        if matches!(b.clone_display().inside(), DisplayInside::FlowRoot) {
            return true;
        }
        if b.clone_float() != Float::None || matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
            return true;
        }
        if self.clips_content(id, style) {
            return true;
        }
        if let Some(p) = node.parent {
            if let Ok(ps) = self.style(p) {
                if ps.get_box().clone_display().is_item_container() {
                    return true;
                }
            }
        }
        use style::values::computed::Contain;
        if b.contain.intersects(Contain::LAYOUT | Contain::PAINT) {
            return true;
        }
        let col = style.get_column();
        !col.column_count.is_auto() || !col.column_width.is_auto()
    }

    // Does the box clip its content — its overflow not `visible` once the viewport has taken the root's, and the body's
    // where the root has none of its own (`clipsContent` / `propagatedOverflow`)?
    fn clips_content(&self, id: NodeId, style: &ComputedValues) -> bool {
        let node = self.node(id);
        let visible = |s: &ComputedValues| s.get_box().overflow_x == Overflow::Visible && s.get_box().overflow_y == Overflow::Visible;
        let parent = node.parent.and_then(|p| self.arena.get(p).map(|n| (p, n)));
        match parent {
            Some((_, pn)) if pn.kind == NodeKind::Document => return false,
            Some((p, pn)) if &*node.local_name == "body" && &*pn.local_name == "html" && pn.parent.and_then(|d| self.arena.get(d)).is_some_and(|d| d.kind == NodeKind::Document) => {
                if self.style(p).is_ok_and(|ps| visible(&ps)) {
                    return false;
                }
            }
            _ => {}
        }
        !visible(style)
    }

    // HTML's LEGACY alignment for this block's block-level descendants (`legacyDescendantAlign`): `<center>`, or an
    // `align` on a `div` / `p` / heading, the nearest ancestor-or-self deciding (rec[65] bits 3-4: 1 center, 2 right,
    // 3 left).
    fn legacy_align(&self, id: NodeId) -> u8 {
        let mut cur = Some(id);
        while let Some(at) = cur {
            let Some(node) = self.arena.get(at) else { break };
            if node.kind != NodeKind::Element {
                break;
            }
            let tag: &str = &node.local_name;
            if tag == "center" {
                return 1;
            }
            if matches!(tag, "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                match node.get_attr("align").map(|v| v.trim().to_ascii_lowercase()).as_deref() {
                    Some("center" | "middle") => return 1,
                    Some("right") => return 2,
                    Some("left") => return 3,
                    _ => {}
                }
            }
            cur = node.parent;
        }
        0
    }
}

// A fresh record as the JS walk starts one (`newRecord`): every field 0, but the declared sizing auto, no comparison
// program anywhere, no containing block in the pass, no pushed cell contribution or row height, no flex line, no
// percentage to resolve, insets auto.
pub(crate) fn fresh_record() -> Input {
    let mut r = [0.0f64; crate::dom::LAYOUT_STRIDE];
    for m in crate::dom::MATH_SLOTS {
        r[m] = f64::NAN;
    }
    // (…no percentage size, flex basis or relative inset to resolve, and insets auto)
    for k in [56, 57, 58, 59, 72, 73, 74, 75, 84, 85, 86, 87, 97, 100, 101, 102, 103, 104, 105, 128, 129, 130] {
        r[k] = f64::NAN;
    }
    r[71] = -1.0;
    crate::dom::decode_input(&r)
}

// A box's four margins then four paddings as length-percentages (None for an `auto` margin), and which margins are
// `auto` (rec[76]: 1 left, 2 right, 4 top, 8 bottom).
fn edge_lps(style: &ComputedValues) -> Result<([Option<&LengthPercentage>; 8], u8), &'static str> {
    use style::values::generics::length::GenericMargin as Margin;
    let m = style.get_margin();
    let p = style.get_padding();
    let mut edges: [Option<&LengthPercentage>; 8] = [None; 8];
    let mut auto = 0u8;
    for (k, margin) in [&m.margin_top, &m.margin_right, &m.margin_bottom, &m.margin_left].into_iter().enumerate() {
        match margin {
            Margin::Auto => auto |= [4, 2, 8, 1][k],
            Margin::LengthPercentage(lp) => edges[k] = Some(lp),
            _ => return Err("margin anchor"),
        }
    }
    for (k, padding) in [&p.padding_top, &p.padding_right, &p.padding_bottom, &p.padding_left].into_iter().enumerate() {
        edges[4 + k] = Some(&padding.0);
    }
    Ok((edges, auto))
}
// The USED border widths, top right bottom left: the computed one is a length whatever the style (css-backgrounds-3),
// and a `none` / `hidden` side draws none.
fn used_borders(style: &ComputedValues) -> [f64; 4] {
    let bd = style.get_border();
    let used = |w: &style::values::computed::BorderSideWidth, s: style::values::specified::BorderStyle| {
        if s.none_or_hidden() { 0.0 } else { w.0.to_f64_px() }
    };
    [
        used(&bd.border_top_width, bd.border_top_style),
        used(&bd.border_right_width, bd.border_right_style),
        used(&bd.border_bottom_width, bd.border_bottom_style),
        used(&bd.border_left_width, bd.border_left_style),
    ]
}
// A run that is an inline box's edge or a break (`nlEncodeRun`): its entry, the edge with no basis, its mode.
fn edge_run(kind: u8, inline: usize, plain: f64, ws: u8) -> Run {
    Run {
        kind,
        font: inline as i32,
        size: 0.0,
        ls: plain,
        ws: 0.0,
        line_height: 0.0,
        asc: 0.0,
        metric: 0.0,
        ws_mode: ws,
        tab_px: 0.0,
        tab_min: 0.0,
        line_mode: 0,
        lands: false,
        plain: if kind == RUN_OPEN || kind == RUN_CLOSE { plain } else { 0.0 },
    }
}
// Two runs' fonts one run can hold (`nlSameFi`).
fn same_font(a: &FontInfo, b: &FontInfo) -> bool {
    a.face == b.face && a.size == b.size && a.ls == b.ls && a.ws == b.ws && a.lh == b.lh && a.tab_px == b.tab_px && a.tab_min == b.tab_min
}
// Does the box sit on its parent's baseline — `vertical-align: baseline`, no shift?
fn baseline_aligned(style: &ComputedValues) -> bool {
    use style::values::generics::box_::GenericBaselineShift as BaselineShift;
    use style::values::specified::box_::AlignmentBaseline;
    let b = style.get_box();
    matches!(&b.baseline_shift, BaselineShift::Length(lp) if lp.to_length().is_some_and(|l| l.px() == 0.0) || lp.to_percentage().is_some_and(|p| p.0 == 0.0))
        && b.alignment_baseline == AlignmentBaseline::Baseline
}
// The face's content box at the element's size (`fontContentHeight`: ascent + descent, each rounded) and its ascent
// (`fontAscent`, what `inlineAscent` answers of a box on the baseline).
fn content_height(style: &ComputedValues, face: &Face) -> f64 {
    let size = font_size(style);
    js_round(face.asc * size) + js_round(face.desc * size)
}
fn content_ascent(style: &ComputedValues, face: &Face) -> f64 {
    js_round(face.asc * font_size(style))
}
// The used font size (`fontOf`'s `computedFontSizePx(el) || 16`).
fn font_size(style: &ComputedValues) -> f64 {
    match style.get_font().font_size.computed_size().px() as f64 {
        0.0 => 16.0,
        s => s,
    }
}

// Why a display this walk has not been taught declines, by what it lays out.
fn display_decline(d: style::values::specified::box_::Display) -> &'static str {
    match (d.outside(), d.inside()) {
        (DisplayOutside::Inline, _) => "atomic inline",
        (_, DisplayInside::Flex) => "flex",
        (_, DisplayInside::Grid) => "grid",
        (_, DisplayInside::Table) => "table",
        (DisplayOutside::TableCaption, _) => "table caption",
        (DisplayOutside::InternalTable, _) => "table part",
        (_, DisplayInside::WebkitBox) => "-webkit-box",
        (_, DisplayInside::Ruby | DisplayInside::RubyBase | DisplayInside::RubyText | DisplayInside::RubyBaseContainer | DisplayInside::RubyTextContainer) => "ruby",
        _ => "display",
    }
}

// An inset's length-percentage, None for `auto`.
fn inset_lp(v: &style::values::computed::position::Inset) -> Result<Option<&LengthPercentage>, &'static str> {
    use style::values::generics::position::GenericInset as Inset;
    match v {
        Inset::LengthPercentage(lp) => Ok(Some(lp)),
        Inset::Auto => Ok(None),
        _ => Err("anchor inset"),
    }
}
// Does the box contain its out-of-flow descendants, fixed ones included (`containsOutOfFlow`): a filter, a transform
// on a box it applies to, layout or paint containment, `content-visibility` other than visible, or a `will-change` that
// promises one.
fn contains_out_of_flow(style: &ComputedValues, node: &crate::dom::NodeData) -> bool {
    use style::values::computed::Contain;
    let effects = style.get_effects();
    if !effects.filter.0.is_empty() || !effects.backdrop_filter.0.is_empty() {
        return true;
    }
    let b = style.get_box();
    let d = b.clone_display();
    let transformable = !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow) && declined_tag(&node.local_name) != Some("replaced or control"))
        && !matches!(d.inside(), DisplayInside::TableColumn | DisplayInside::TableColumnGroup);
    if transformable
        && (!b.transform.0.is_empty()
            || !matches!(b.perspective, style::values::generics::box_::GenericPerspective::None)
            || !matches!(b.translate, style::values::generics::transform::GenericTranslate::None)
            || !matches!(b.rotate, style::values::generics::transform::GenericRotate::None)
            || !matches!(b.scale, style::values::generics::transform::GenericScale::None))
    {
        return true;
    }
    if b.contain.intersects(Contain::LAYOUT | Contain::PAINT) {
        return true;
    }
    use style::computed_values::content_visibility::T as ContentVisibility;
    if b.content_visibility != ContentVisibility::Visible {
        return true;
    }
    use style::values::specified::box_::WillChangeBits;
    b.will_change.bits.intersects(WillChangeBits::FIXPOS_CB_NON_SVG | WillChangeBits::TRANSFORM | WillChangeBits::PERSPECTIVE | WillChangeBits::CONTAIN)
}

// A size's length-percentage, None for `auto` / `none` / a keyword.
fn size_lp(v: &style::values::computed::Size) -> Result<Option<&LengthPercentage>, &'static str> {
    use style::values::generics::length::GenericSize as Size;
    match v {
        Size::LengthPercentage(lp) => Ok(Some(&lp.0)),
        Size::AnchorSizeFunction(_) | Size::AnchorContainingCalcFunction(_) => Err("anchor size"),
        _ => Ok(None),
    }
}
fn max_size_lp(v: &style::values::computed::MaxSize) -> Result<Option<&LengthPercentage>, &'static str> {
    use style::values::generics::length::GenericMaxSize as MaxSize;
    match v {
        MaxSize::LengthPercentage(lp) => Ok(Some(&lp.0)),
        MaxSize::AnchorSizeFunction(_) | MaxSize::AnchorContainingCalcFunction(_) => Err("anchor size"),
        _ => Ok(None),
    }
}

// A COMPARISON program (layout.js `nlMathProgram`, evaluated by `layout::math_at`): postfix triples `[op, a, b]` —
// `MATH_LINE` pushes `a + b × basis`, `MATH_MIN` / `MATH_MAX` / `MATH_SUM` fold the top two, `MATH_NEG` negates the top
// and `MATH_SCALE` multiplies it by `a`. A piece with no comparison inside is ONE line, its `px + frac × basis`.

// A value the record carries for native to resolve at the basis it has: `px + frac × basis`, or its program (whose pair
// is then its figure at no basis) — `nlClampedSpec`'s `{px, frac, prog}`.
struct Spec {
    px: f64,
    frac: f64,
    prog: Option<Vec<f64>>,
}

type CalcNode = style::values::computed::length_percentage::CalcNode;

// `lp` as a Spec: its pair where it is affine in its basis — a length, a percentage, a `calc()` of them — and its
// program where a comparison bends it.
fn spec(lp: &LengthPercentage) -> Result<Spec, &'static str> {
    use style::values::computed::length_percentage::Unpacked;
    match lp.unpack() {
        Unpacked::Length(l) => Ok(Spec { px: l.px() as f64, frac: 0.0, prog: None }),
        Unpacked::Percentage(p) => Ok(Spec { px: 0.0, frac: p.0 as f64, prog: None }),
        Unpacked::Calc(calc) => match linear(calc.node()) {
            Some((px, frac)) => Ok(Spec { px, frac, prog: None }),
            None => {
                let prog = program(calc.node())?;
                Ok(Spec { px: math_at(&prog, 0.0), frac: 0.0, prog: Some(prog) })
            }
        },
    }
}
// …what it is at a basis.
fn at(lp: &LengthPercentage, basis: f64) -> Result<f64, &'static str> {
    let s = spec(lp)?;
    Ok(spec_at(&s, basis))
}
fn spec_at(s: &Spec, basis: f64) -> f64 {
    match &s.prog {
        Some(prog) => math_at(prog, basis),
        None if s.frac == 0.0 => s.px,
        None => s.px + s.frac * basis,
    }
}
// A calc tree with no comparison in it, as its `px + frac × basis`.
fn linear(node: &CalcNode) -> Option<(f64, f64)> {
    use style::values::computed::length_percentage::ComputedLeaf as Leaf;
    use style::values::generics::calc::GenericCalcNode as Node;
    match node {
        Node::Leaf(Leaf::Length(l)) => Some((l.px() as f64, 0.0)),
        Node::Leaf(Leaf::Percentage(p)) => Some((0.0, p.0 as f64)),
        Node::Negate(n) => linear(n).map(|(px, frac)| (-px, -frac)),
        Node::Sum(terms) => terms.iter().try_fold((0.0, 0.0), |(px, frac), t| linear(t).map(|(p, f)| (px + p, frac + f))),
        Node::Product(factors) => {
            let (scale, operand) = product(factors)?;
            linear(operand).map(|(px, frac)| (px * scale, frac * scale))
        }
        _ => None,
    }
}
// A product's NUMBERS, multiplied (a division is an inverted one), and its one operand that is not a number.
fn product(factors: &[CalcNode]) -> Option<(f64, &CalcNode)> {
    use style::values::computed::length_percentage::ComputedLeaf as Leaf;
    use style::values::generics::calc::GenericCalcNode as Node;
    let mut scale = 1.0f64;
    let mut operand = None;
    for f in factors {
        match f {
            Node::Leaf(Leaf::Number(n)) => scale *= *n as f64,
            Node::Invert(inner) => match &**inner {
                Node::Leaf(Leaf::Number(n)) => scale /= *n as f64,
                _ => return None,
            },
            _ if operand.is_none() => operand = Some(f),
            _ => return None,
        }
    }
    scale.is_finite().then_some(())?;
    operand.map(|o| (scale, o))
}
// A calc tree as its program.
fn program(node: &CalcNode) -> Result<Vec<f64>, &'static str> {
    let mut prog = Vec::new();
    let mut depth = 0usize;
    let mut deepest = 0usize;
    emit(node, &mut prog, &mut depth, &mut deepest)?;
    if deepest > MATH_DEPTH {
        return Err("math too deep");
    }
    Ok(prog)
}
fn emit(node: &CalcNode, prog: &mut Vec<f64>, depth: &mut usize, deepest: &mut usize) -> Step {
    use style::values::generics::calc::{GenericCalcNode as Node, MinMaxOp};
    if let Some((px, frac)) = linear(node) {
        prog.extend([MATH_LINE, px, frac]);
        *depth += 1;
        *deepest = (*deepest).max(*depth);
        return Ok(());
    }
    let fold = |prog: &mut Vec<f64>, depth: &mut usize, op: f64| {
        prog.extend([op, 0.0, 0.0]);
        *depth -= 1;
    };
    match node {
        Node::MinMax(args, op) => {
            let op = if matches!(op, MinMaxOp::Min) { MATH_MIN } else { MATH_MAX };
            for (i, a) in args.iter().enumerate() {
                emit(a, prog, depth, deepest)?;
                if i > 0 {
                    fold(prog, depth, op);
                }
            }
            if args.is_empty() {
                return Err("math function");
            }
        }
        // (…CSS's own `max(lo, min(v, hi))`: where the bounds cross, the minimum wins)
        Node::Clamp { min, center, max } => {
            emit(min, prog, depth, deepest)?;
            emit(center, prog, depth, deepest)?;
            emit(max, prog, depth, deepest)?;
            fold(prog, depth, MATH_MIN);
            fold(prog, depth, MATH_MAX);
        }
        Node::Sum(terms) => {
            for (i, t) in terms.iter().enumerate() {
                emit(t, prog, depth, deepest)?;
                if i > 0 {
                    fold(prog, depth, MATH_SUM);
                }
            }
        }
        Node::Negate(n) => {
            emit(n, prog, depth, deepest)?;
            prog.extend([MATH_NEG, 0.0, 0.0]);
        }
        Node::Product(factors) => {
            let (scale, operand) = product(factors).ok_or("math function")?;
            emit(operand, prog, depth, deepest)?;
            if scale != 1.0 {
                prog.extend([MATH_SCALE, scale, 0.0]);
            }
        }
        _ => return Err("math function"),
    }
    Ok(())
}
// A program at a basis — native's own evaluation (`layout::math_at`), which is what it will come to there.
fn math_at(prog: &[f64], basis: f64) -> f64 {
    let mut table = Vec::with_capacity(prog.len() + 1);
    table.push((prog.len() / 3) as f64);
    table.extend_from_slice(prog);
    crate::layout::math_at(&table, 0, basis)
}

// The bases the JS walk probes an edge at to decide it is on its line (`NL_EDGE_PROBE` / `NL_EDGE_CHECKS`).
const EDGE_PROBE: f64 = 1_048_576.0;
const EDGE_CHECKS: [f64; 4] = [217.0, 1531.0, 4099.0, 30011.0];

// A box's four margins and four paddings as the record carries them: each one's length part, its fraction of the
// containing block's width, and its program where a comparison bends it (`nlEdgeParts` / `nlClampedEdgeParts`).
struct EdgeParts {
    px: [f64; 8],
    frac: [f64; 8],
    prog: [Option<Vec<f64>>; 8],
}

impl EdgeParts {
    // Each edge at `basis` — an `auto` margin 0, a padding floored at 0 (`edgeInsets`).
    fn values(edges: &[Option<&LengthPercentage>; 8], basis: f64) -> Result<[f64; 8], &'static str> {
        let mut out = [0.0; 8];
        for (k, lp) in edges.iter().enumerate() {
            if let Some(lp) = lp {
                let v = at(lp, basis)?;
                out[k] = if k >= 4 { v.max(0.0) } else { v };
            }
        }
        Ok(out)
    }
    // …all resolved at one basis, no fraction left.
    fn at(edges: &[Option<&LengthPercentage>; 8], basis: f64) -> Result<EdgeParts, &'static str> {
        Ok(EdgeParts { px: Self::values(edges, basis)?, frac: [0.0; 8], prog: Default::default() })
    }
    // …as `px + frac × basis` each, where every one is on its line: read at 0 and at the far probe, and checked at the
    // bases between where a math function could bend one — None where one does.
    fn linear(edges: &[Option<&LengthPercentage>; 8]) -> Result<Option<EdgeParts>, &'static str> {
        use style::values::computed::length_percentage::Unpacked;
        let px = Self::values(edges, 0.0)?;
        let far = Self::values(edges, EDGE_PROBE)?;
        let frac: [f64; 8] = std::array::from_fn(|k| (far[k] - px[k]) / EDGE_PROBE);
        if edges.iter().flatten().any(|lp| matches!(lp.unpack(), Unpacked::Calc(_))) {
            for basis in EDGE_CHECKS {
                let got = Self::values(edges, basis)?;
                if (0..8).any(|k| (got[k] - (px[k] + frac[k] * basis)).abs() > 1e-3) {
                    return Ok(None);
                }
            }
        }
        Ok(Some(EdgeParts { px, frac, prog: Default::default() }))
    }
    // …and where one is not: each edge's own Spec, a padding that varies as a program floored at 0.
    fn clamped(edges: &[Option<&LengthPercentage>; 8]) -> Result<EdgeParts, &'static str> {
        let mut parts = EdgeParts { px: [0.0; 8], frac: [0.0; 8], prog: Default::default() };
        for (k, lp) in edges.iter().enumerate() {
            let Some(lp) = lp else { continue };
            let s = spec(lp)?;
            if k < 4 {
                parts.px[k] = s.px;
                parts.frac[k] = s.frac;
                parts.prog[k] = s.prog;
                continue;
            }
            let prog = if s.prog.is_none() && s.frac == 0.0 {
                None
            } else {
                let mut prog = s.prog.unwrap_or_else(|| vec![MATH_LINE, s.px, s.frac]);
                prog.extend([MATH_LINE, 0.0, 0.0, MATH_MAX, 0.0, 0.0]);
                Some(prog)
            };
            parts.px[k] = match &prog {
                Some(prog) => math_at(prog, 0.0),
                None => s.px.max(0.0),
            };
            parts.prog[k] = prog;
        }
        // (…held to what the edges ARE at the probes, as the JS walk holds them: a shape neither form reproduces is the
        // one it would resolve against its own layout's basis, which this walk declines.)
        for basis in std::iter::once(EDGE_PROBE).chain(EDGE_CHECKS) {
            let want = Self::values(edges, basis)?;
            for k in 0..8 {
                let got = match &parts.prog[k] {
                    Some(prog) => math_at(prog, basis),
                    None => parts.px[k] + parts.frac[k] * basis,
                };
                if !((want[k] - got).abs() <= 1e-3) {
                    return Err("percentage-basis");
                }
            }
        }
        Ok(parts)
    }
}

// A length's px — a value with a percentage in it is not taught yet.
fn length(lp: &LengthPercentage) -> Result<f64, &'static str> {
    lp.to_length().map(|l: Length| l.px() as f64).ok_or("percentage")
}
// A letter- or word-spacing's px.
fn spacing(lp: &LengthPercentage) -> Result<f64, &'static str> {
    lp.to_length().map(|l| l.px() as f64).ok_or("spacing-percentage")
}
// Does a height leave the box's margins adjoining — `auto`, a keyword, or a zero length (`autoOrZeroHeight`)?
fn auto_or_zero(v: &style::values::computed::Size) -> bool {
    use style::values::generics::length::GenericSize as Size;
    match v {
        Size::LengthPercentage(lp) => lp.0.to_length().is_some_and(|l| l.px() == 0.0) || lp.0.to_percentage().is_some_and(|p| p.0 == 0.0),
        _ => true,
    }
}
fn scrolls(o: Overflow) -> bool {
    matches!(o, Overflow::Scroll | Overflow::Auto | Overflow::Hidden)
}
// The white-space mode (`WS_MODE[whiteSpaceOf(el)]`) — the six `white-space` values the longhands spell.
fn ws_mode_of(style: &ComputedValues) -> Result<u8, &'static str> {
    use style::computed_values::text_wrap_mode::T as TextWrapMode;
    let t = style.get_inherited_text();
    let wrap = t.text_wrap_mode == TextWrapMode::Wrap;
    Ok(match (t.white_space_collapse, wrap) {
        (WhiteSpaceCollapse::Collapse, true) => WS_NORMAL,
        (WhiteSpaceCollapse::Collapse, false) => WS_NOWRAP,
        (WhiteSpaceCollapse::Preserve, false) => WS_PRE,
        (WhiteSpaceCollapse::Preserve, true) => WS_PRE_WRAP,
        (WhiteSpaceCollapse::PreserveBreaks, true) => WS_PRE_LINE,
        (WhiteSpaceCollapse::BreakSpaces, true) => WS_BREAK_SPACES,
        _ => return Err("white-space-mode-unknown"),
    })
}
fn preserving(mode: u8) -> bool {
    matches!(mode, WS_PRE | WS_PRE_WRAP | WS_BREAK_SPACES)
}
// Can native measure `text` in a run of in-word break mode `wrap` (`nlTextMeasurable`)? Not a zero-width joiner where
// the line breaks per character, nor one beside a wide character: the JS layout's two paths disagree with each other
// there, and no native answer can match both.
fn measurable(text: &[u16], wrap: u8) -> bool {
    let mut zwj = false;
    let mut wide = false;
    for (i, &u) in text.iter().enumerate() {
        if u == 0x200D {
            zwj = true;
        } else if u >= 0x1100 {
            // (…as `codePointAt(i)` reads it: a surrogate pair's code point from its high half, a lone half itself)
            let cp = match (u, text.get(i + 1)) {
                (0xD800..=0xDBFF, Some(&lo @ 0xDC00..=0xDFFF)) => 0x10000 + (((u as u32) - 0xD800) << 10) + ((lo as u32) - 0xDC00),
                _ => u as u32,
            };
            if crate::font::is_wide_char(cp) {
                wide = true;
            }
        }
    }
    !(zwj && (wrap == 1 || wrap == 3 || wide))
}
// Is `text` anything but CSS white space (`CSS_CONTENT_RE`)?
fn has_content(text: &[u16]) -> bool {
    text.iter().any(|&u| !is_css_ws(u))
}
fn is_css_ws(u: u16) -> bool {
    matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C)
}
// Does white space alone make a line under `mode` (`whiteSpaceOnlyIsContent`)?
fn white_space_only_is_content(text: &[u16], mode: u8) -> bool {
    if text.is_empty() {
        return false;
    }
    if preserving(mode) {
        text.iter().any(|&u| u != 0x0D && u != 0x0C)
    } else {
        mode == WS_PRE_LINE && text.contains(&0x0A)
    }
}
// The block's `text-indent` as the record takes it (`nlIndentOf`): its Spec and the hanging / each-line bits.
fn indent(style: &ComputedValues) -> Result<(Spec, u32), &'static str> {
    let ti = &style.get_inherited_text().text_indent;
    Ok((spec(&ti.length)?, (if ti.hanging { 256 } else { 0 }) | (if ti.each_line { 512 } else { 0 })))
}
// …and whether it can come to anything at some basis (`nlIndentMayBite`).
fn indent_may_bite(style: &ComputedValues) -> Result<bool, &'static str> {
    let (s, _) = indent(style)?;
    Ok(s.px != 0.0 || s.frac != 0.0 || s.prog.is_some())
}
// The line alignment code (`nlAlignCode(textAlignOf(…))`): 0 left, 1 right, 2 center, 3 justify.
fn align_code(align: TextAlign, starts_at_right: bool) -> u8 {
    match align {
        TextAlign::Right | TextAlign::MozRight => 1,
        TextAlign::Center | TextAlign::MozCenter => 2,
        TextAlign::Justify => 3,
        TextAlign::End => if starts_at_right { 0 } else { 1 },
        TextAlign::Left | TextAlign::MozLeft => 0,
        _ => if starts_at_right { 1 } else { 0 },
    }
}
// The in-word break mode (`nlWrapMode`): 0 none, 1 break-all, 2 break-word, 3 anywhere.
fn wrap_mode(style: &ComputedValues) -> u8 {
    let t = style.get_inherited_text();
    let break_all = t.word_break == WordBreak::BreakAll;
    let wrap = t.overflow_wrap;
    if !(break_all || wrap != OverflowWrap::Normal) {
        return 0;
    }
    if break_all {
        return 1;
    }
    if wrap == OverflowWrap::Anywhere { 3 } else { 2 }
}
// JavaScript's `Math.round`: halves go UP, toward +∞.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

// Where two walks built a record differently, field by field: each differing field's name, whether it differs only as
// much as f32 precision does (stylo keeps lengths as f32), and the two values.
pub(crate) struct FieldDiff {
    pub(crate) field: &'static str,
    pub(crate) close: bool,
    pub(crate) js: String,
    pub(crate) rust: String,
}
pub(crate) fn input_diff(js: &Input, js_maths: &[f64], rust: &Input, rust_maths: &[f64]) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    // (…a program by what it IS: the two walks write the same value in different shapes and at different offsets.)
    macro_rules! cmp_math {
        ($($f:ident),* $(,)?) => {$(
            let (a, b) = (math_refs(&js.$f), math_refs(&rust.$f));
            if let Some(close) = a.iter().zip(b).map(|(&a, &b)| program_diff(js_maths, a, rust_maths, b)).fold(None, worse) {
                out.push(FieldDiff { field: stringify!($f), close, js: format!("{:?}", a.iter().map(|&m| program_text(js_maths, m)).collect::<Vec<_>>()), rust: format!("{:?}", b.iter().map(|&m| program_text(rust_maths, m)).collect::<Vec<_>>()) });
            }
        )*};
    }
    cmp_math!(flex_main_gap_math, flex_cross_gap_math, chain_math, rel_math, flex_basis_math, pct_math, edge_math, inset_math, indent_math);
    macro_rules! cmp {
        ($($f:ident),* $(,)?) => {$(
            if let Some(close) = Same::diff(&js.$f, &rust.$f) {
                out.push(FieldDiff { field: stringify!($f), close, js: format!("{:?}", js.$f), rust: format!("{:?}", rust.$f) });
            }
        )*};
    }
    cmp!(
        nid, parent, display, border_box, width, height, min_w, max_w, min_h, max_h, mt, mr, mb, ml, pt, pr, pb, pl,
        bt, br, bb, bl, height_adjoins, minh_adjoins, bottom_adjoins, run_start, run_count, strut_lh, strut_asc,
        float_kind, clear, takes_clearance, starts_bfc, flex_justify, flex_main_gap, flex_cross_align, flex_main_is_x,
        flex_wrap, flex_cross_flip, flex_align_content, flex_cross_gap, flex_main_reverse, flex_cross_far,
        has_replayed_oof, rel_x, rel_y, rel_pct, rel_x_px, rel_x_neg, measured_as_block, equal_share, chain_rel,
        chain_px, chain_shift, flex_item_auto, flex_baseline_asc, flex_line_nat, flex_line, out_of_flow, sp_x, sp_y,
        cell_col, cell_colspan, cell_rowspan, caption_side, rtl, text_align, anon_cross, ws_mode, item_auto_height,
        pushed_h_indefinite, grid_start, decl_w, decl_min_w, decl_max_w, flex_basis, flex_grow, decl_border_box,
        flex_shrink, flex_basis_cb, flex_basis_frac, pct_sizes, pct_px, edge_frac, edge_px, basis_w, inset_frac,
        flex_main_gap_frac, flex_cross_gap_frac, flex_basis_kw, scrolls_x, scrolls_y, is_button, self_sizes,
        block_axis_is_x, decl_edges_x, decl_margin_x, height_from_outside, cell_pct, cell_min_content,
        cell_max_content, height_is_floor, cell_valign, cell_pct_h_child, anon_group, group_pct_h, pct_h_decl,
        row_imposed, row_height, row_pct, row_rank, table_fixed, flex_stretch, flex_native, flex_dir_reverse,
        replaced, lays_out_children, ratio, ratio_only, shrinks_to_nothing, control_baseline, control_font_box,
        control_font_asc, intrinsic_w, intrinsic_h, cb_index, cb_rect, inset_top, inset_right, inset_bottom,
        inset_left, auto_margins, legacy_align, indent_px, indent_frac, indent_hanging, indent_each_line,
        indent_spent, width_kw,
    );
    out
}
// …an inline box's entry.
pub(crate) fn inline_diff(js: &InlineBox, js_maths: &[f64], rust: &InlineBox, rust_maths: &[f64]) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    macro_rules! cmp {
        ($($f:ident),* $(,)?) => {$(
            if let Some(close) = Same::diff(&js.$f, &rust.$f) {
                out.push(FieldDiff { field: stringify!($f), close, js: format!("{:?}", js.$f), rust: format!("{:?}", rust.$f) });
            }
        )*};
    }
    cmp!(ml, right, mr, top, bottom, own_h, own_asc, rel_x, rel_y, bt, br, bb, bl, f_ml, f_left, f_right, f_mr, f_top, f_bottom, left, rel_xf, rel_yf, rel_yi);
    for (field, a, b) in [("math", &js.math[..], &rust.math[..]), ("rel_math", &js.rel_math[..], &rust.rel_math[..])] {
        if let Some(close) = a.iter().zip(b).map(|(&a, &b)| program_diff(js_maths, a, rust_maths, b)).fold(None, worse) {
            let text = |maths, refs: &[u32]| format!("{:?}", refs.iter().map(|&m| program_text(maths, m)).collect::<Vec<_>>());
            out.push(FieldDiff { field, close, js: text(js_maths, a), rust: text(rust_maths, b) });
        }
    }
    out
}
// …and a run.
pub(crate) fn run_diff(js: &Run, rust: &Run) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    macro_rules! cmp {
        ($($f:ident),* $(,)?) => {$(
            if let Some(close) = Same::diff(&js.$f, &rust.$f) {
                out.push(FieldDiff { field: stringify!($f), close, js: format!("{:?}", js.$f), rust: format!("{:?}", rust.$f) });
            }
        )*};
    }
    cmp!(kind, font, size, ls, ws, line_height, asc, metric, ws_mode, tab_px, tab_min, line_mode, lands, plain);
    out
}

// A math field as its offsets, one or several.
trait MathRefs {
    fn refs(&self) -> &[u32];
}
impl MathRefs for u32 {
    fn refs(&self) -> &[u32] {
        std::slice::from_ref(self)
    }
}
impl<const N: usize> MathRefs for [u32; N] {
    fn refs(&self) -> &[u32] {
        self
    }
}
fn math_refs<T: MathRefs + ?Sized>(v: &T) -> &[u32] {
    v.refs()
}
// The program at `at` in a math table (`[length, op, a, b, …]`), or None for NO_MATH or an offset past the table.
fn program_at(maths: &[f64], at: u32) -> Option<&[f64]> {
    if at == crate::layout::NO_MATH {
        return None;
    }
    let at = at as usize;
    let n = *maths.get(at)? as usize;
    maths.get(at + 1..at + 1 + n * 3)
}
// Whether two programs differ in what they come to, at bases a page's width spans and past them.
fn program_diff(a_maths: &[f64], a: u32, b_maths: &[f64], b: u32) -> Option<bool> {
    match (program_at(a_maths, a), program_at(b_maths, b)) {
        (None, None) => None,
        (Some(_), Some(_)) => [0.0, 50.0, 217.0, 400.0, 1531.0, 4099.0, 30011.0, EDGE_PROBE]
            .iter()
            .map(|&basis| crate::layout::math_at(a_maths, a as usize, basis).diff(&crate::layout::math_at(b_maths, b as usize, basis)))
            .fold(None, worse),
        _ => Some(false),
    }
}
fn program_text(maths: &[f64], at: u32) -> String {
    match program_at(maths, at) {
        Some(p) => format!("{p:?}"),
        None => "-".into(),
    }
}
fn worse(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), _) | (_, Some(true)) => Some(true),
        _ => None,
    }
}

// Whether two field values differ: None where they are the same (two NaNs are), Some(true) where they differ only as
// much as an f32 does from the f64 it rounds (stylo keeps lengths as f32), Some(false) where they really differ.
trait Same {
    fn diff(&self, other: &Self) -> Option<bool>;
}
impl Same for f64 {
    fn diff(&self, other: &f64) -> Option<bool> {
        if self == other || (self.is_nan() && other.is_nan()) {
            None
        } else {
            Some((self - other).abs() <= 1e-5 * self.abs().max(other.abs()).max(1.0))
        }
    }
}
macro_rules! same_eq {
    ($($t:ty),*) => {$(
        impl Same for $t {
            fn diff(&self, other: &$t) -> Option<bool> {
                if self == other { None } else { Some(false) }
            }
        }
    )*};
}
same_eq!(bool, u8, i32, u32, usize);
impl<T: Same, const N: usize> Same for [T; N] {
    fn diff(&self, other: &[T; N]) -> Option<bool> {
        let mut worst = None;
        for (a, b) in self.iter().zip(other) {
            match a.diff(b) {
                Some(false) => return Some(false),
                Some(true) => worst = Some(true),
                None => {}
            }
        }
        worst
    }
}
