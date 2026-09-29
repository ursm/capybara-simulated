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
use crate::layout::{Input, Run, RunText, DISPLAY_BLOCK, DISPLAY_TEXT_BLOCK, RUN_TEXT};

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
}

impl Faces {
    pub(crate) fn learn(&mut self, key: FaceKey, face: Option<Face>) {
        self.known.insert(key, face);
    }
}

// What a walk hands the layout pass: its records, its runs and their texts.
pub(crate) struct Built {
    pub(crate) inputs: Vec<Input>,
    pub(crate) runs: Vec<Run>,
    pub(crate) run_texts: Vec<RunText>,
}

pub(crate) enum Outcome {
    Built(Built),
    Declined(&'static str),
    NeedsFaces,
}

// Walk the subtree at `root` — the element the JS walk took as its pass root.
pub(crate) fn build(arena: &RealmArena, root: NodeId, faces: &mut Faces) -> Outcome {
    faces.missing.clear();
    let mut walk = Walk { arena, faces, inputs: Vec::new(), runs: Vec::new(), run_texts: Vec::new() };
    match walk.root(root) {
        Ok(()) => Outcome::Built(Built { inputs: walk.inputs, runs: walk.runs, run_texts: walk.run_texts }),
        Err(_) if !walk.faces.missing.is_empty() => Outcome::NeedsFaces,
        Err(why) => Outcome::Declined(why),
    }
}

type Step = Result<(), &'static str>;

struct Walk<'a> {
    arena: &'a RealmArena,
    faces: &'a mut Faces,
    inputs: Vec<Input>,
    runs: Vec<Run>,
    run_texts: Vec<RunText>,
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
// the widgets and the replaced elements) — and, for now, the ones this walk declines outright, since each is sized from
// data or UA rules it has not been taught (`intrinsicSize`).
const OWN_CONTEXT_TAGS: &[&str] = &[
    "input", "select", "textarea", "button", "meter", "progress", "img", "canvas", "video", "audio", "object", "embed",
    "iframe", "frame", "svg",
];

impl<'a> Walk<'a> {
    fn root(&mut self, root: NodeId) -> Step {
        let style = self.style(root)?;
        let b = style.get_box();
        if matches!(b.clone_position(), Position::Absolute | Position::Fixed) || b.clone_float() != Float::None {
            return Err("root unsupported");
        }
        self.record(root, -1)
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

    // One element's record, and its subtree's (`walkRecord`).
    fn record(&mut self, id: NodeId, parent: i32) -> Step {
        let node = self.node(id);
        let style = self.style(id)?;
        let tag: &str = &node.local_name;
        if !node.is_html() {
            return Err("foreign element");
        }
        if OWN_CONTEXT_TAGS.contains(&tag) {
            return Err("replaced or control");
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
            return Err("display");
        }
        if b.clone_position() != Position::Static {
            return Err("positioned");
        }
        if b.clone_float() != Float::None {
            return Err("float");
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
        rec.width = size(&pos.width)?;
        if rec.width.is_nan() && !matches!(pos.width, style::values::generics::length::GenericSize::Auto) {
            return Err("width keyword");
        }
        rec.height = size(&pos.height)?;
        rec.min_w = size(&pos.min_width)?;
        rec.max_w = max_size(&pos.max_width)?;
        rec.min_h = size(&pos.min_height)?;
        rec.max_h = max_size(&pos.max_height)?;
        rec.decl_w = rec.width;
        rec.decl_min_w = rec.min_w;
        rec.decl_max_w = rec.max_w;
        let m = style.get_margin();
        let margins = [&m.margin_top, &m.margin_right, &m.margin_bottom, &m.margin_left];
        let mut auto = 0u8;
        let mut mv = [0.0; 4];
        for (k, margin) in margins.iter().enumerate() {
            match margin {
                style::values::generics::length::GenericMargin::Auto => auto |= [4, 2, 8, 1][k],
                style::values::generics::length::GenericMargin::LengthPercentage(lp) => mv[k] = length(lp)?,
                _ => return Err("margin anchor"),
            }
        }
        rec.auto_margins = auto;
        [rec.mt, rec.mr, rec.mb, rec.ml] = mv;
        let p = style.get_padding();
        [rec.pt, rec.pr, rec.pb, rec.pl] =
            [length(&p.padding_top.0)?, length(&p.padding_right.0)?, length(&p.padding_bottom.0)?, length(&p.padding_left.0)?];
        // The USED border widths: the computed one is a length whatever the style (css-backgrounds-3), and a `none` /
        // `hidden` side draws none.
        let bd = style.get_border();
        let used = |w: &style::values::computed::BorderSideWidth, s: style::values::specified::BorderStyle| {
            if s.none_or_hidden() { 0.0 } else { w.0.to_f64_px() }
        };
        [rec.bt, rec.br, rec.bb, rec.bl] = [
            used(&bd.border_top_width, bd.border_top_style),
            used(&bd.border_right_width, bd.border_right_style),
            used(&bd.border_bottom_width, bd.border_bottom_style),
            used(&bd.border_left_width, bd.border_left_style),
        ];
        rec.edge_px = [rec.mt, rec.mr, rec.mb, rec.ml, rec.pt, rec.pr, rec.pb, rec.pl];
        rec.decl_edges_x = rec.pl + rec.pr + rec.bl + rec.br;
        rec.decl_margin_x = rec.ml + rec.mr;
        rec.height_adjoins = auto_or_zero(&pos.height);
        rec.minh_adjoins = auto_or_zero(&pos.min_height);
        rec.bottom_adjoins = rec.height.is_nan();
        rec.clear = match b.clone_clear() {
            Clear::None => 0,
            Clear::Left => 1,
            Clear::Right => 2,
            Clear::Both => 3,
            _ => return Err("logical clear"),
        };
        rec.starts_bfc = self.establishes_bfc(id, &style);
        let rtl = style.get_inherited_box().direction == Direction::Rtl;
        rec.rtl = rtl as u8;
        rec.scrolls_x = scrolls(b.overflow_x);
        rec.scrolls_y = scrolls(b.overflow_y);
        rec.legacy_align = self.legacy_align(id);
        self.inputs.push(rec);

        // What the children are to this block's flow: block-level boxes, or inline content (`walkRecord`'s classify).
        let ws_mode = ws_mode(&style)?;
        let mut blocks = Vec::new();
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
                        return Err("out of flow");
                    }
                    if cb.clone_float() != Float::None {
                        return Err("float");
                    }
                    if matches!(cd.outside(), DisplayOutside::Inline) {
                        return Err("inline content");
                    }
                    blocks.push(c);
                }
                _ => {}
            }
        }
        if inline && !blocks.is_empty() {
            return Err("mixed block");
        }
        if inline {
            return self.text_block(id, idx, &style, ws_mode);
        }
        self.inputs[idx as usize].display = DISPLAY_BLOCK;
        self.inputs[idx as usize].ws_mode = ws_mode;
        for c in blocks {
            self.record(c, idx)?;
        }
        Ok(())
    }

    // A block of text alone (`walkRecord`'s text-block arm over `nlGatherRuns`).
    fn text_block(&mut self, id: NodeId, idx: i32, style: &ComputedValues, ws_mode: u8) -> Step {
        let (indent_px, indent_bits) = indent(style)?;
        let font = self.font_info(style, style)?;
        let starts_at_right = style.get_inherited_box().direction == Direction::Rtl;
        let align = align_code(style.get_inherited_text().text_align, starts_at_right);
        let wrap_mode = wrap_mode(style);
        let no_shy = style.get_inherited_text().hyphens == Hyphens::None;
        let preserve = preserving(ws_mode);
        let owner_wraps = ws_mode != WS_NOWRAP && ws_mode != WS_PRE;
        let run_start = self.runs.len();
        let mut makes_line = false;
        let mut last: Option<Vec<u16>> = None;
        let mut texts: Vec<Vec<u16>> = Vec::new();
        for c in self.children(id).collect::<Vec<_>>() {
            let cn = self.node(c);
            if cn.kind != NodeKind::Text {
                continue;
            }
            let raw = &cn.data;
            let stripped: Vec<u16> = if preserve { raw.iter().copied().filter(|&u| u != 0x0D && u != 0x0C).collect() } else { raw.clone() };
            let td: Vec<u16> = if no_shy && stripped.contains(&0xAD) { stripped.iter().copied().filter(|&u| u != 0xAD).collect() } else { stripped.clone() };
            if td.is_empty() && !raw.is_empty() && indent_px != 0.0 {
                return Err("text-not-measurable");
            }
            if td.is_empty() && !stripped.is_empty() {
                return Err("text-not-measurable");
            }
            if td.contains(&0x200D) {
                return Err("zero-width joiner");
            }
            if td.is_empty() {
                continue;
            }
            if has_content(&td) || white_space_only_is_content(&td, ws_mode) {
                makes_line = true;
            }
            // Adjacent text is one run, as the JS walk merges it (`appendText`): same font (one block here), where the
            // mode soft-wraps, and not across a join that GLUES a word, nor across a white-space-only side of a
            // `pre-line` join.
            match last.as_mut() {
                Some(prev)
                    if owner_wraps
                        && (is_css_ws(*prev.last().unwrap()) || is_css_ws(td[0]))
                        && !(ws_mode == WS_PRE_LINE && has_content(prev) != has_content(&td)) =>
                {
                    prev.extend_from_slice(&td);
                }
                _ => {
                    if let Some(prev) = last.take() {
                        texts.push(prev);
                    }
                    last = Some(td);
                }
            }
        }
        if let Some(prev) = last.take() {
            texts.push(prev);
        }
        // (…the indent and the alignment written before the gather, as the JS walk writes them: a block whose text
        // makes no line keeps them too.)
        let rec = &mut self.inputs[idx as usize];
        rec.indent_px = indent_px;
        rec.indent_frac = 0.0;
        rec.indent_hanging = indent_bits & 256 != 0;
        rec.indent_each_line = indent_bits & 512 != 0;
        rec.text_align = align;
        rec.ws_mode = ws_mode;
        if !makes_line {
            rec.display = DISPLAY_BLOCK;
            return Ok(());
        }
        rec.display = DISPLAY_TEXT_BLOCK;
        rec.run_start = run_start as i32;
        rec.run_count = texts.len() as i32;
        rec.strut_lh = font.lh;
        rec.strut_asc = font.asc;
        for text in texts {
            self.runs.push(Run {
                kind: RUN_TEXT,
                font: font.face,
                size: font.size,
                ls: font.ls,
                ws: font.ws,
                line_height: font.lh,
                asc: font.asc,
                metric: wrap_mode as f64,
                ws_mode,
                tab_px: font.tab_px,
                tab_min: font.tab_min,
                line_mode: 0,
                lands: false,
                plain: 0.0,
            });
            self.run_texts.push(Some(text.into()));
        }
        Ok(())
    }

    // `owner`'s font as a run takes it, its tab stops counted in `block`'s (`nlFontInfo` / `fontOf` / `lineHeightOf`
    // / `baselineWithin` / `tabStopOf`).
    fn font_info(&mut self, owner: &ComputedValues, block: &ComputedValues) -> Result<FontInfo, &'static str> {
        let face = self.face(owner)?;
        let f = owner.get_font();
        let size = match f.font_size.computed_size().px() as f64 {
            0.0 => 16.0,
            s => s,
        };
        let ls = spacing(&owner.get_inherited_text().letter_spacing.0)?;
        let ws = spacing(&owner.get_inherited_text().word_spacing)?;
        use style::values::generics::font::GenericLineHeight as LineHeight;
        let lh = match &f.line_height {
            LineHeight::Normal => js_round(face.asc * size) + js_round(face.desc * size) + js_round(face.gap * size),
            LineHeight::Number(n) => js_round(n.0 as f64 * size),
            LineHeight::Length(l) => js_round(l.0.px() as f64),
        };
        let asc = ((lh - (js_round(face.asc * size) + js_round(face.desc * size))) / 2.0).floor() + js_round(face.asc * size);
        // The tab stops, in the BLOCK's font.
        let block_face = self.face(block)?;
        let bf = block.get_font();
        let bsize = match bf.font_size.computed_size().px() as f64 {
            0.0 => 16.0,
            s => s,
        };
        let bls = spacing(&block.get_inherited_text().letter_spacing.0)?;
        let bws = spacing(&block.get_inherited_text().word_spacing)?;
        let bare = block_face.space * bsize;
        let unit_space = bare + bls + bws;
        use style::values::generics::length::GenericLengthOrNumber as LengthOrNumber;
        let raw = match &block.get_inherited_text().tab_size {
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
            Some(Some(face)) if face.handle >= 0 && !face.asc.is_nan() => Ok(*face),
            Some(_) => Err("run-font-not-system"),
            None => {
                self.faces.missing.push(key);
                Err("needs faces")
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

    // Does the element establish a block formatting context (`computeEstablishesBFC`)? Asked of a block-level
    // in-flow `flow` / `flow-root` box, which is all this walk takes.
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

// A size (`width`, `height`, `min-*`): its px, NaN for `auto` and the keywords.
fn size(v: &style::values::computed::Size) -> Result<f64, &'static str> {
    use style::values::generics::length::GenericSize as Size;
    match v {
        Size::LengthPercentage(lp) => length(&lp.0),
        Size::AnchorSizeFunction(_) | Size::AnchorContainingCalcFunction(_) => Err("anchor size"),
        _ => Ok(f64::NAN),
    }
}
fn max_size(v: &style::values::computed::MaxSize) -> Result<f64, &'static str> {
    use style::values::generics::length::GenericMaxSize as MaxSize;
    match v {
        MaxSize::LengthPercentage(lp) => length(&lp.0),
        MaxSize::AnchorSizeFunction(_) | MaxSize::AnchorContainingCalcFunction(_) => Err("anchor size"),
        _ => Ok(f64::NAN),
    }
}
// A length's px — a value with a percentage in it is not taught yet.
fn length(lp: &LengthPercentage) -> Result<f64, &'static str> {
    lp.to_length().map(|l: Length| l.px() as f64).ok_or("percentage")
}
// A letter- or word-spacing's px.
fn spacing(lp: &LengthPercentage) -> Result<f64, &'static str> {
    length(lp)
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
fn ws_mode(style: &ComputedValues) -> Result<u8, &'static str> {
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
// The block's `text-indent` as the record takes it: its px and the hanging / each-line bits.
fn indent(style: &ComputedValues) -> Result<(f64, u32), &'static str> {
    let ti = &style.get_inherited_text().text_indent;
    let px = length(&ti.length)?;
    Ok((px, (if ti.hanging { 256 } else { 0 }) | (if ti.each_line { 512 } else { 0 })))
}
fn indent_may_bite(style: &ComputedValues) -> Result<bool, &'static str> {
    Ok(indent(style)?.0 != 0.0)
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
pub(crate) fn input_diff(js: &Input, rust: &Input) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    macro_rules! cmp {
        ($($f:ident),* $(,)?) => {$(
            if let Some(close) = Same::diff(&js.$f, &rust.$f) {
                out.push(FieldDiff { field: stringify!($f), close, js: format!("{:?}", js.$f), rust: format!("{:?}", rust.$f) });
            }
        )*};
    }
    cmp!(
        nid, parent, display, border_box, width, height, min_w, max_w, min_h, max_h, mt, mr, mb, ml, pt, pr, pb, pl, bt, br,
        bb, bl, height_adjoins, minh_adjoins, bottom_adjoins, run_start, run_count, strut_lh, strut_asc, float_kind, clear,
        takes_clearance, starts_bfc, flex_justify, flex_main_gap, flex_cross_align, flex_main_is_x, flex_wrap, flex_cross_flip,
        flex_align_content, flex_cross_gap, flex_main_reverse, flex_cross_far, has_replayed_oof, rel_x, rel_y, rel_pct,
        rel_x_px, rel_x_neg, measured_as_block, equal_share, chain_rel, chain_px, chain_shift, chain_math, rel_math,
        flex_item_auto, flex_baseline_asc, flex_line_nat, flex_line, out_of_flow, sp_x, sp_y, cell_col, cell_colspan,
        cell_rowspan, caption_side, rtl, text_align, anon_cross, ws_mode, item_auto_height, pushed_h_indefinite, grid_start,
        decl_w, decl_min_w, decl_max_w, flex_basis, flex_grow, decl_border_box, flex_shrink, flex_basis_cb, flex_basis_frac,
        flex_basis_math, pct_sizes, pct_px, pct_math, edge_frac, edge_px, edge_math, basis_w, inset_frac, inset_math,
        flex_main_gap_frac, flex_main_gap_math, flex_cross_gap_math, indent_math, flex_cross_gap_frac, flex_basis_kw,
        scrolls_x, scrolls_y, is_button, self_sizes, block_axis_is_x, decl_edges_x, decl_margin_x, height_from_outside,
        cell_pct, cell_min_content, cell_max_content, height_is_floor, cell_valign, cell_pct_h_child, anon_group,
        group_pct_h, pct_h_decl, row_imposed, row_height, row_pct, row_rank, table_fixed, flex_stretch, flex_native,
        flex_dir_reverse, replaced, lays_out_children, ratio, ratio_only, shrinks_to_nothing, control_baseline,
        control_font_box, control_font_asc, intrinsic_w, intrinsic_h, cb_index, cb_rect, inset_top, inset_right,
        inset_bottom, inset_left, auto_margins, legacy_align, indent_px, indent_frac, indent_hanging, indent_each_line,
        indent_spent, width_kw,
    );
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
