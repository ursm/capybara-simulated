// The layout WALK: the arena and the style engine's computed values turned into the records a layout pass reads
// (`layout::Input`, its runs and their texts, its grid and inline tables), with no V8 crossing per element — the one
// path from style to layout. `build` walks the flat tree from the pass root and `layout.rs` lays the records out.
//
// The VALUES come from the style engine; the MODEL rules are the walk's own — a line height rounded to whole px, a
// baseline floored within its line box, a face bucketed to regular / bold × italic and resolved by the JS side
// (`Outcome::NeedsFaces`), a generated box made by the JS side before its record can name it (`Outcome::NeedsBoxes`).
//
// A pass that built a subtree's records exactly as the last one did reuses them: an unchanged subtree is spliced back
// from the last kept pass (`Walk::splice`), and its layout put back from the measure cache (`walk_reuse`).
//
// It builds only what it has been taught, and DECLINES the rest by name (`Outcome::Declined`) — a box no container
// arm lays out, an out-of-flow box whose containing block is outside the pass, a block-level box inside inline content
// it cannot split, a run in a face that is no system font, a math function past what a program can hold, a table shape
// it does not model, an edge whose percentages no pair or program reproduces at every basis. A declined walk declines
// the whole page: layout.js lays the root box out alone and counts the reason. So a shape it takes is one whose
// records say only what the page declares.

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
use style::values::specified::box_::{Display, DisplayInside, DisplayOutside};

// The display the walk lays a box out by: the style engine's, with a `-webkit-box` / `-webkit-inline-box` a plain
// BLOCK, its children in its flow rather than items — and a RUBY display an inline box, its annotation on the line
// beside its base (a `block ruby` is a block). Chrome lays the first out as a legacy flex box, clamping lines by
// `-webkit-line-clamp`, and a ruby with its annotation above its base: divergences recorded. (A ruby display an AUTHOR
// gives any other element is inline-level too: that is what the spec and Chrome say, and which origin a display came
// from is no computed value.)
// …except on a `<button>`, laid out by HTML's button layout: an inline-level display is an inline-block there and any
// other a flow-root, and an internal ruby display is no inline-level one — a flow-root block, as Chrome lays it out
// (`button-layout/display-other`). `tag` is the element's `rendering_tag`.
pub(crate) trait WalkDisplay {
    fn walk_display(&self, tag: &str) -> Display;
}
impl WalkDisplay for style::properties::style_structs::Box {
    fn walk_display(&self, tag: &str) -> Display {
        let d = self.clone_display();
        match d.inside() {
            DisplayInside::WebkitBox => Display::Block,
            DisplayInside::Ruby
            | DisplayInside::RubyBase
            | DisplayInside::RubyText
            | DisplayInside::RubyBaseContainer
            | DisplayInside::RubyTextContainer => {
                let internal = !matches!(d.inside(), DisplayInside::Ruby);
                if matches!(d.outside(), DisplayOutside::Block) || (internal && tag == "button") { Display::Block } else { Display::Inline }
            }
            _ => d,
        }
    }
}

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::style::StyleEngine;
use crate::geometry::flat_children;
use crate::layout::{MATH_LINE, MATH_MAX, MATH_MIN, MATH_NEG, MATH_SCALE, MATH_SUM};
use crate::layout::{InlineBox, Input, Run, RunText, DISPLAY_BLOCK, DISPLAY_TEXT_BLOCK, RUN_ATOMIC, RUN_BR, RUN_CLOSE, RUN_FLOAT, RUN_OOF, RUN_OPEN, RUN_TEXT, RUN_WBR};

// A face the walk measures a run in, as the JS side resolves it for the family and the weight / style bucket: the
// layout's font handle and the metrics the model rules read off it (per em — ascent, descent, line gap, and the
// advance of a space, or the face's average where it has none).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Face {
    pub(crate) handle: i32,
    pub(crate) asc: f64,
    pub(crate) desc: f64,
    pub(crate) gap: f64,
    pub(crate) space: f64,
    // (…and its x-height, CSS's half an em where the face carries none)
    pub(crate) xh: f64,
}

// Whether two answers for a face are the same face, to the bit: its handle (a `size-adjust` is a handle of its own) and
// its metrics.
fn same_face(a: Option<Face>, b: Option<Face>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.handle == b.handle
                && [a.asc, a.desc, a.gap, a.space, a.xh].iter().zip([b.asc, b.desc, b.gap, b.space, b.xh]).all(|(x, y)| x.to_bits() == y.to_bits())
        }
        _ => false,
    }
}

// Which face: the family list as the computed value serializes it, and its weight / style bucket (`''`, `bold`,
// `italic`, `bold:italic`).
pub(crate) type FaceKey = (String, &'static str);

// The faces a realm has been told of — ONE table, which the walk and the style engine's font metrics (`ex`, `ch`) both
// read — and the ones asked for and not told: the walk's, which it names by declining with `Outcome::NeedsFaces` for the
// caller to resolve and walk again, and the style engine's, which a walk names as well and whose styles are computed
// again once they are told (`learn`). None is a face the family does not resolve to.
#[derive(Default, Debug)]
pub(crate) struct Faces {
    known: HashMap<FaceKey, Option<Face>>,
    pub(crate) missing: Vec<FaceKey>,
    metrics_missing: Vec<FaceKey>,
    // …and the faces it DID compute a metric from: what has to be asked for again, and its styles computed again, once
    // what they resolve by moves (`at_generation`).
    metrics_used: Vec<FaceKey>,
    // …and what each of those was before it was asked for again: told the same face, nothing it computed changes, and
    // nothing is restyled — the generation moves on every style sheet change, and a restyle of everything costs the
    // transitions their before-change styles.
    prior: HashMap<FaceKey, Option<Face>>,
    // The generation the faces were resolved at (`natFontGen`: the rules and the FontFaceSet a family resolves by).
    generation: String,
}

// A realm's faces, held by its arena and shared with its style engine's font metrics, which ask from inside a style
// traversal with no scope to find the arena by. The REALM's and nothing wider: a table keyed by realm id alone was one
// every isolate shared, so a second session's realm 1 found the first one's faces known and never fetched its web fonts.
#[derive(Default, Clone, Debug)]
pub(crate) struct SharedFaces(std::sync::Arc<std::sync::Mutex<Faces>>);
impl SharedFaces {
    pub(crate) fn with<R>(&self, f: impl FnOnce(&mut Faces) -> R) -> R {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

// A style's face key: its family list as it serializes, and the bucket its weight and style fall in.
pub(crate) fn face_key(f: &style::properties::style_structs::Font) -> FaceKey {
    use style_traits::ToCss;
    let bold = f.font_weight.value() >= 600.0;
    let italic = f.font_style != style::values::computed::font::FontStyle::NORMAL;
    let bucket = match (bold, italic) {
        (false, false) => "",
        (true, false) => "bold",
        (false, true) => "italic",
        (true, true) => "bold:italic",
    };
    (f.font_family.to_css_string(), bucket)
}

impl Faces {
    // A face the JS side resolved — and whether the style engine had asked for it and computed with a stand-in, for
    // its styles to be computed again.
    pub(crate) fn learn(&mut self, key: FaceKey, face: Option<Face>) -> bool {
        let asked = self.metrics_missing.iter().position(|k| *k == key).map(|at| self.metrics_missing.remove(at)).is_some();
        let unchanged = self.prior.remove(&key).is_some_and(|was| same_face(was, face));
        self.known.insert(key, face);
        asked && !unchanged
    }
    // The face the style engine's font metrics are read from: its own where it is known, else None — noted, where it has
    // not been asked for yet, for the next walk to name.
    pub(crate) fn for_metrics(&mut self, key: FaceKey) -> Option<Face> {
        match self.known.get(&key) {
            Some(face) => {
                if !self.metrics_used.contains(&key) {
                    self.metrics_used.push(key);
                }
                *face
            }
            None => {
                if !self.metrics_missing.contains(&key) {
                    self.metrics_missing.push(key);
                }
                None
            }
        }
    }
    // The faces the style engine asked for and has not been told of (`__dom.styleFaces`).
    pub(crate) fn metrics_missing(&self) -> &[FaceKey] {
        &self.metrics_missing
    }
    // Forget every face once what they resolve by has moved — and ask again for each one the style engine computed a
    // metric from: a face whose `size-adjust` or source changed would otherwise go on giving the `ch` / `ex` of the old
    // one, since nothing computed from it is computed again until it is told (`learn`, then a restyle).
    pub(crate) fn at_generation(&mut self, generation: &str) {
        if self.generation != generation {
            for key in std::mem::take(&mut self.metrics_used) {
                if let Some(&was) = self.known.get(&key) {
                    self.prior.insert(key.clone(), was);
                }
                if !self.metrics_missing.contains(&key) {
                    self.metrics_missing.push(key);
                }
            }
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
    pub(crate) grids: Vec<f64>,
    // …and what names each box to the JS side: the anonymous ones as `[record, kind, container nid, ordinal]`, and
    // the element each inline table entry is of, by nid.
    pub(crate) anon: Vec<[f64; 4]>,
    pub(crate) inline_nids: Vec<f64>,
    // …and what each record's subtree was (`Extent`), the subtrees spliced back from the last pass rather than walked
    // (`Splice`), and the layout epoch the walk began at (`RealmArena::begin_layout_walk`) — for `walk_reuse`.
    pub(crate) extents: Vec<Extent>,
    pub(crate) spliced: Vec<Splice>,
    pub(crate) walked: u64,
    // …and what a painter needs of each TEXT run the walk made, beside its text (`PaintMark`) — none for a run spliced
    // back from the last pass, so a pass that paints is walked whole.
    pub(crate) paint: Vec<PaintMark>,
}
// A text run as a painter draws it: its run index, its baseline shift, and the element each part of it was written in
// (`[(offset, nid)]`) — or whose `::placeholder` it is, for a control showing its placeholder (`control_text`).
pub(crate) struct PaintMark {
    pub(crate) run: usize,
    pub(crate) shift: f64,
    pub(crate) owners: Vec<(u32, f64)>,
    pub(crate) placeholder: bool,
}

// What the walk knows of a record beyond the record: where the run, grid and inline streams stood as it went in, and —
// for one a subtree was walked from — where its records and streams ended when the walk returned from it; for a block
// child of a block container, what its walk read from outside it (`Ctx`) and the floats its formatting context had
// placed when it was done. A subtree emits all it emits between its root going in and the walk returning from it.
#[derive(Clone, Copy)]
pub(crate) struct Extent {
    pub(crate) start: [usize; 3],
    pub(crate) end: Option<[usize; 4]>,
    pub(crate) ctx: Option<Ctx>,
    pub(crate) saw_out: (bool, bool),
}

// What the walk of a block container's block child reads from outside the child's subtree — which splicing it back
// from the last pass needs to be what it was (`Walk::splice`): the floats its formatting context had placed on each side
// when it began (whether its `clear` separates it), the parent's `align` / `<center>` (`legacy_align`) and direction
// (an inline-start float's side), the viewport (a fixed box's containing block) and the root font size (an `<svg>`'s em
// attributes).
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Ctx {
    saw_in: (bool, bool),
    legacy_align: u8,
    parent_rtl: bool,
    basis: [u64; 2],
    root_font_size: u64,
}

// A subtree spliced back: the record it went in at, the record it was at in the last pass, and how many records it holds.
#[derive(Clone, Copy)]
pub(crate) struct Splice {
    pub(crate) at: usize,
    pub(crate) was: usize,
    pub(crate) n: usize,
}

// The last kept pass (`walk_reuse`) as a walk splices from it and `walk_reuse` holds the next against it: its streams
// as the walk built them — before the layout wrote into its records — what it knew of each record, each element's
// record by nid, where each record's subtree ends, the chunk each was the root of (0: none), which subtrees can be spliced
// (none whose out-of-flow box names a containing block outside it), and the epoch it was walked at.
pub(crate) struct Prior {
    pub(crate) inputs: Vec<Input>,
    pub(crate) runs: Vec<Run>,
    pub(crate) run_texts: Vec<RunText>,
    pub(crate) grids: Vec<f64>,
    pub(crate) inlines: Vec<InlineBox>,
    pub(crate) extents: Vec<Extent>,
    pub(crate) anon: Vec<[f64; 4]>,
    pub(crate) inline_nids: Vec<f64>,
    pub(crate) by_nid: HashMap<u64, usize>,
    pub(crate) ends: Vec<usize>,
    pub(crate) ids: Vec<u32>,
    pub(crate) spliceable: Vec<bool>,
    pub(crate) walked: u64,
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
    // …and the generated boxes that render with no node linked for them yet — each as its element's nid and 0 for
    // `::before`, 1 for `::after` — for the JS side to make (`pseudoNodeFor`) and walk again.
    NeedsBoxes(Vec<f64>),
}

// The programs a pass's records name (`[length, op, a, b, …]` at each one's offset), each once — the REALM's, kept
// from pass to pass so a program keeps its offset: an offset then names one program for good, which is what lets a
// record be held against the last pass's by its offsets alone, and a measure be keyed on one (`walk_reuse`). Built
// afresh per pass, `min(50%, 100px)` edited to `min(50%, 120px)` sat at the same offset with other constants, and the
// width measured for the first was put back for the second.
#[derive(Default)]
pub(crate) struct MathTable {
    pub(crate) values: Vec<f64>,
    index: HashMap<Vec<u64>, u32>,
}

// The direction the ROOT element USES — the principal writing mode's (CSS Writing Modes 3 §8): its `<body>` child's where
// it has one, else its own. `<body dir=rtl>` in an ltr document lays the body out from the right, and scrolls the
// viewport from there (Chrome and Firefox alike); the root's COMPUTED `direction`, which `getComputedStyle` reports, is
// its own either way.
pub(crate) fn principal_rtl(arena: &RealmArena, root: NodeId) -> bool {
    principal_style(arena, root).is_some_and(|s| s.get_inherited_box().direction == Direction::Rtl)
}
// …and whether the initial containing block STARTS at its right, which is where the root then sits: a horizontal
// principal writing mode's inline start under `rtl`, a vertical one's BLOCK start under `vertical-rl` / `sideways-rl`
// (Chrome puts a `vertical-rl` html against the right edge, a `vertical-lr` one with `dir=rtl` against the left: in a
// vertical mode the horizontal axis is the block axis, which `direction` has no say in).
pub(crate) fn principal_starts_right(arena: &RealmArena, root: NodeId) -> bool {
    principal_style(arena, root).is_some_and(|s| match s.writing_mode {
        wm if wm.is_vertical() => !wm.is_vertical_lr(),
        _ => s.get_inherited_box().direction == Direction::Rtl,
    })
}
fn principal_style(arena: &RealmArena, root: NodeId) -> Option<Arc<ComputedValues>> {
    let body = arena.get(root).filter(|r| r.is_html_named("html")).and_then(|r| {
        r.children.iter().copied().find(|&c| arena.get(c).is_some_and(|n| matches!(n.rendering_tag(), "body" | "frameset")))
    });
    crate::style::primary_style(arena, body.unwrap_or(root))
}

// A computed `position` as a box answers it (`layout::Box::position`).
pub(crate) fn position_code(position: Position) -> u8 {
    match position {
        Position::Static => crate::layout::POSITION_STATIC,
        Position::Relative => crate::layout::POSITION_RELATIVE,
        Position::Absolute => crate::layout::POSITION_ABSOLUTE,
        Position::Fixed => crate::layout::POSITION_FIXED,
        Position::Sticky => crate::layout::POSITION_STICKY,
    }
}

// (…`painting`: a pass a painter records, whose text runs keep what it draws them by — `PaintMark` — and none else does)
pub(crate) fn build(arena: &RealmArena, engine: Option<&StyleEngine>, root: NodeId, basis: Basis, faces: &mut Faces, maths: &mut MathTable, prior: Option<&Prior>, painting: bool) -> Outcome {
    faces.missing.clear();
    let walked = arena.begin_layout_walk();
    let texts = typed_arena::Arena::new();
    let generated = Generated { arena, texts: &texts, state: Default::default() };
    let mut walk = Walk {
        arena,
        engine,
        generated: &generated,
        faces,
        basis,
        inputs: Vec::new(),
        runs: Vec::new(),
        run_texts: Vec::new(),
        paint: Vec::new(),
        painting,
        grids: Vec::new(),
        maths: &mut maths.values,
        math_index: &mut maths.index,
        inlines: Vec::new(),
        entries: Vec::new(),
        rec_index: HashMap::new(),
        root,
        saw_float: (false, false),
        entry_el: Vec::new(),
        inline_of: HashMap::new(),
        inline_cbs: Vec::new(),
        collapse: HashMap::new(),
        anon: Vec::new(),
        extents: Vec::new(),
        prior,
        attempts: 0,
        spliced: Vec::new(),
        root_font_size: None,
    };
    let done = walk.root(root).and_then(|()| walk.resolve_inline_cbs());
    // (…the generated boxes it met that render with no node to name them by: made, and the pass walked again)
    let unlinked = std::mem::take(&mut generated.state.borrow_mut().unlinked);
    if !unlinked.is_empty() {
        return Outcome::NeedsBoxes(unlinked);
    }
    // (…and the faces the style engine computed a font metric with a stand-in for, which it computes again once told)
    for key in walk.faces.metrics_missing.clone() {
        if !walk.faces.missing.contains(&key) {
            walk.faces.missing.push(key);
        }
    }
    if !walk.faces.missing.is_empty() {
        return Outcome::NeedsFaces;
    }
    let mut inline_nids = vec![-1.0; walk.inlines.len()];
    for (el, &at) in &walk.inline_of {
        inline_nids[at] = el.to_f64();
    }
    match done {
        Ok(()) => Outcome::Built(Built {
            inputs: walk.inputs,
            runs: walk.runs,
            run_texts: walk.run_texts,
            paint: walk.paint,
            inlines: walk.inlines,
            grids: walk.grids,
            inline_nids,
            anon: walk.anon,
            extents: walk.extents,
            spliced: walk.spliced,
            walked,
        }),
        Err(why) => Outcome::Declined(why),
    }
}

type Step = Result<(), &'static str>;

// A pass's GENERATED CONTENT (`pseudoNodeFor`): each `::before` / `::after` box that renders, the element it is of, and
// the text its `content` makes of the style engine's value. The box is the node the JS side registered for it
// (`linkPseudoBox`), so the record names a node the JS side holds; its text is the one node the walk makes itself,
// since no tree holds one — an id of its own generation, which no arena node has.
//
// An element's boxes are resolved the first time the walk asks for its children (`boxes_of`, from `push_children`) —
// never for a subtree the walk does not enter — and a box that renders with no node linked for it is noted then, for the
// pass to answer once the walk is done (`Outcome::NeedsBoxes`).
struct Generated<'a> {
    arena: &'a RealmArena,
    // (…the texts' home, which hands out references for as long as the walk runs)
    texts: &'a typed_arena::Arena<crate::dom::NodeData>,
    state: std::cell::RefCell<GeneratedState<'a>>,
}
#[derive(Default)]
struct GeneratedState<'a> {
    // Each element resolved so far, with its rendering boxes, `::before` and `::after`…
    of: HashMap<NodeId, [Option<NodeId>; 2]>,
    // …and each box's element, which of the two it is, and its text (none for an empty one).
    boxes: HashMap<NodeId, (NodeId, usize, Option<NodeId>)>,
    texts: Vec<&'a crate::dom::NodeData>,
    // The boxes that render which the JS side has not linked to their element — none to name the record by — as
    // `[element nid, 0 before / 1 after, …]`.
    unlinked: Vec<f64>,
}
const GENERATED_TEXT: u32 = u32::MAX;
pub(crate) const PSEUDOS: [style::selector_parser::PseudoElement; 2] =
    [style::selector_parser::PseudoElement::Before, style::selector_parser::PseudoElement::After];
// The elements that generate no content whatever they declare (`NO_GENERATED_CONTENT`): the replaced ones, the
// controls, and the breaks — and a `<progress>` / `<meter>`, which the walk lays out as a leaf of its own size, so no
// box it could generate is ever there (Chrome draws none either).
const NO_GENERATED_CONTENT: [&str; 16] = [
    "img", "input", "textarea", "select", "iframe", "video", "audio", "canvas", "object", "embed", "svg", "br", "wbr", "frame",
    "progress", "meter",
];

impl<'a> Generated<'a> {
    // An element's rendering boxes, `::before` and `::after`, resolved the first time it is asked.
    fn boxes_of(&self, id: NodeId) -> [Option<NodeId>; 2] {
        if let Some(&boxes) = self.state.borrow().of.get(&id) {
            return boxes;
        }
        let mut boxes = [None, None];
        if let Some(node) = self.arena.get(id) {
            for which in 0..PSEUDOS.len() {
                let Some(text) = generated_text_of(self.arena, id, which) else { continue };
                let mut st = self.state.borrow_mut();
                let Some(at) = node.pseudo_boxes[which].filter(|&b| self.arena.get(b).is_some()) else {
                    st.unlinked.extend([id.to_f64(), which as f64]);
                    continue;
                };
                let text = (!text.is_empty()).then(|| {
                    let tid = NodeId { idx: st.texts.len() as u32, generation: GENERATED_TEXT };
                    st.texts.push(self.texts.alloc(crate::dom::NodeData { parent: Some(at), ..crate::dom::NodeData::of_kind(NodeKind::Text, text) }));
                    tid
                });
                boxes[which] = Some(at);
                st.boxes.insert(at, (id, which, text));
            }
        }
        self.state.borrow_mut().of.insert(id, boxes);
        boxes
    }
    // A generated box's element, which of the two it is and its text — None for any other node. (A box is only ever
    // met through its element's children, by when its element is resolved.)
    fn box_info(&self, id: NodeId) -> Option<(NodeId, usize, Option<NodeId>)> {
        self.state.borrow().boxes.get(&id).copied()
    }
    // A generated box's text node.
    fn text(&self, id: NodeId) -> Option<&'a crate::dom::NodeData> {
        self.state.borrow().texts.get(id.idx as usize).copied()
    }
}
// What `id`'s `::before` (0) or `::after` (1) renders as the style engine styled it: its text (empty for a box that
// holds none), or None where it generates no box.
pub(crate) fn generated_text_of(arena: &RealmArena, id: NodeId, which: usize) -> Option<Vec<u16>> {
    let node = arena.get(id).filter(|n| n.kind == NodeKind::Element && !NO_GENERATED_CONTENT.contains(&n.rendering_tag()))?;
    crate::style::eager_pseudo(arena, id, &PSEUDOS[which]).and_then(|style| generated_text(&style, node))
}
// What a generated box's `content` renders (`generatedContentOf`), or None for none: its strings, an `attr()` of its
// element (its fallback where the element has none), the quote marks `quotes` gives — and nothing for a counter or an
// image, nor for the alternative text past `/`.
fn generated_text(style: &ComputedValues, element: &crate::dom::NodeData) -> Option<Vec<u16>> {
    use style::values::generics::counters::{GenericContent, GenericContentItem as Item};
    use style::values::specified::list::Quotes;
    let GenericContent::Items(items) = &style.get_counters().content else { return None };
    let quote = |open: bool| -> String {
        match &style.get_list().quotes {
            Quotes::Auto => (if open { "\u{201C}" } else { "\u{201D}" }).to_owned(),
            Quotes::QuoteList(list) => list.0.first().map_or_else(String::new, |q| (if open { &q.opening } else { &q.closing }).to_string()),
        }
    };
    let mut out = String::new();
    for item in &items.items[..items.alt_start.min(items.items.len())] {
        match item {
            Item::String(s) => out.push_str(s),
            Item::Attr(attr) => out.push_str(element.get_attr(&attr.attribute).unwrap_or(&attr.fallback)),
            Item::OpenQuote => out.push_str(&quote(true)),
            Item::CloseQuote => out.push_str(&quote(false)),
            _ => {}
        }
    }
    Some(out.encode_utf16().collect())
}

struct Walk<'a> {
    arena: &'a RealmArena,
    // (…its style engine, for the styles no traversal computed: a `::placeholder`'s)
    engine: Option<&'a StyleEngine>,
    generated: &'a Generated<'a>,
    faces: &'a mut Faces,
    basis: Basis,
    inputs: Vec<Input>,
    runs: Vec<Run>,
    run_texts: Vec<RunText>,
    paint: Vec<PaintMark>,
    painting: bool,
    // The grid stream a table's (or a grid's) record names its columns in (`grid_start`).
    grids: Vec<f64>,
    // The programs the records name, each once (`[length, op, a, b, …]` at its offset), and where each one is — the
    // realm's table (`MathTable`).
    maths: &'a mut Vec<f64>,
    math_index: &'a mut HashMap<Vec<u64>, u32>,
    // The inline table (`InlineBox` per inline box the runs open, in the order they open them), and the entries the
    // gathers made, which a text block tables when its runs are committed.
    inlines: Vec<InlineBox>,
    entries: Vec<InlineBox>,
    // Each element's record, for an out-of-flow box to name its containing block by.
    rec_index: HashMap<NodeId, i32>,
    // The pass root, and whether a float has been placed on the left / right in the formatting context the walk is in.
    root: NodeId,
    saw_float: (bool, bool),
    // The element each gathered entry is of, each tabled inline box's entry by element, and the out-of-flow records whose
    // containing block is an inline box (`layout::CB_INLINE`), named by its entry once the pass has tabled it.
    entry_el: Vec<NodeId>,
    inline_of: HashMap<NodeId, usize>,
    inline_cbs: Vec<(i32, NodeId)>,
    // A collapsing table's cells, each with the half-borders the grid resolved for it (`ensureCollapseBorders`), top
    // right bottom left: what its record carries in place of its own borders.
    collapse: HashMap<NodeId, [f64; 4]>,
    // The ANONYMOUS cells and items the pass holds, each by its record — which kind (1 a table's cell, 2 a flex or grid
    // container's item), its container, and which of the container's anonymous ones it is: what names it to the JS
    // side, whose memoised object it is (`tableGrid` / `boxItems`).
    anon: Vec<[f64; 4]>,
    // What each record's subtree was (`Built::extents`).
    extents: Vec<Extent>,
    // The last kept pass, which an unchanged subtree is spliced back from (`splice`) — None where there is none, or
    // where the pass has to be walked whole (a pass that paints, the reuse check's second walk).
    prior: Option<&'a Prior>,
    // How deep in an ATTEMPT the walk is — `mixed_block`'s group, taken back if it makes no line: nothing is spliced in
    // one, whose taking back would have to take the splice back too.
    attempts: u32,
    spliced: Vec<Splice>,
    root_font_size: Option<f64>,
}

// An alignment keyword as the walk reads it: `safe` / `unsafe` dropped, `first baseline` the baseline.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Kw {
    Auto,
    Normal,
    Start,
    End,
    FlexStart,
    FlexEnd,
    Center,
    Left,
    Right,
    Baseline,
    LastBaseline,
    Stretch,
    SelfStart,
    SelfEnd,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
    Other,
}
fn align_kw(flags: style::values::specified::align::AlignFlags) -> Kw {
    use style::values::specified::align::AlignFlags as F;
    match flags.value() {
        F::AUTO => Kw::Auto,
        F::NORMAL => Kw::Normal,
        F::START => Kw::Start,
        F::END => Kw::End,
        F::FLEX_START => Kw::FlexStart,
        F::FLEX_END => Kw::FlexEnd,
        F::CENTER => Kw::Center,
        F::LEFT => Kw::Left,
        F::RIGHT => Kw::Right,
        F::BASELINE => Kw::Baseline,
        F::LAST_BASELINE => Kw::LastBaseline,
        F::STRETCH => Kw::Stretch,
        F::SELF_START => Kw::SelfStart,
        F::SELF_END => Kw::SelfEnd,
        F::SPACE_BETWEEN => Kw::SpaceBetween,
        F::SPACE_AROUND => Kw::SpaceAround,
        F::SPACE_EVENLY => Kw::SpaceEvenly,
        _ => Kw::Other,
    }
}
// `align-content` as the code the layout reads.
fn align_content_code(flags: style::values::specified::align::AlignFlags) -> u8 {
    match align_kw(flags) {
        Kw::FlexStart | Kw::Baseline => 0,
        Kw::Center => 1,
        Kw::FlexEnd => 2,
        Kw::SpaceBetween => 3,
        Kw::SpaceAround => 4,
        Kw::SpaceEvenly => 5,
        Kw::Start => 7,
        Kw::End => 8,
        _ => 6,
    }
}

// A physical side.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Side {
    Left,
    Right,
    Top,
    Bottom,
}
// An element's flow as the physical sides it runs between (`flowSides` / `FLOW_SIDES`): block-start, block-end,
// inline-start, inline-end — the inline pair turned round by `direction: rtl`.
pub(crate) fn flow_sides(style: &ComputedValues) -> [Side; 4] {
    use style::computed_values::writing_mode::T as WritingMode;
    let [bs, be, is, ie] = match style.get_inherited_box().writing_mode {
        WritingMode::HorizontalTb => [Side::Top, Side::Bottom, Side::Left, Side::Right],
        WritingMode::VerticalRl | WritingMode::SidewaysRl => [Side::Right, Side::Left, Side::Top, Side::Bottom],
        WritingMode::VerticalLr => [Side::Left, Side::Right, Side::Top, Side::Bottom],
        WritingMode::SidewaysLr => [Side::Left, Side::Right, Side::Bottom, Side::Top],
    };
    if style.get_inherited_box().direction == Direction::Rtl { [bs, be, ie, is] } else { [bs, be, is, ie] }
}
// Does the element's inline axis start at the RIGHT — what moves a line's alignment: `rtl` in a
// horizontal writing mode, never in a vertical one, whose lines run down.
fn starts_at_right(style: &ComputedValues) -> bool {
    matches!(flow_sides(style)[2], Side::Right)
}

// Where a line's baseline alignment is asked: a row keeps it, a column reads it along the axis, an out-of-flow box's
// static position in the flow.
#[derive(Clone, Copy, PartialEq)]
enum BaselineMode {
    Keep,
    Axis,
    Flow,
}
impl BaselineMode {
    fn of(plan: &FlexPlan) -> BaselineMode {
        if plan.column { BaselineMode::Axis } else { BaselineMode::Keep }
    }
}

// A flex container's axes, in a horizontal writing mode: where the main axis starts, the
// cross axis starts, whether that is the far edge, and how the lines wrap (0 nowrap, 1 wrap, 2 wrap-reverse).
pub(crate) struct FlexPlan {
    column: bool,
    flex_reverse: bool,
    pub(crate) main_start: Side,
    cross_start: Side,
    pub(crate) main_is_x: bool,
    main_reverse: bool,
    pub(crate) cross_far: bool,
    cross_flip: bool,
    wrap: u8,
    // …and the side a line's LEFT is on in a vertical writing mode — the top, but `sideways-lr`'s bottom — which a
    // vertical row's `justify-content: left` / `right` name)
    line_left: Side,
}
impl FlexPlan {
    pub(crate) fn of(style: &ComputedValues) -> FlexPlan {
        use style::computed_values::flex_direction::T as Dir;
        use style::computed_values::flex_wrap::T as Wrap;
        let pos = style.get_position();
        // (…`row` is the INLINE axis and `column` the BLOCK one, whichever physical way the flow runs: `flowSides`)
        let [block_start, block_end, inline_start, inline_end] = flow_sides(style);
        let column = matches!(pos.flex_direction, Dir::Column | Dir::ColumnReverse);
        let flex_reverse = matches!(pos.flex_direction, Dir::RowReverse | Dir::ColumnReverse);
        let wrap = match pos.flex_wrap {
            Wrap::Nowrap => 0,
            Wrap::Wrap => 1,
            Wrap::WrapReverse => 2,
        };
        let cross_flip = wrap == 2;
        let main_start = match (column, flex_reverse) {
            (true, false) => block_start,
            (true, true) => block_end,
            (false, false) => inline_start,
            (false, true) => inline_end,
        };
        let cross_start = match (column, cross_flip) {
            (true, false) => inline_start,
            (true, true) => inline_end,
            (false, false) => block_start,
            (false, true) => block_end,
        };
        FlexPlan {
            column,
            flex_reverse,
            main_start,
            cross_start,
            main_is_x: matches!(main_start, Side::Left | Side::Right),
            main_reverse: matches!(main_start, Side::Right | Side::Bottom),
            cross_far: matches!(cross_start, Side::Right | Side::Bottom),
            cross_flip,
            wrap,
            line_left: if matches!(style.get_inherited_box().writing_mode, style::computed_values::writing_mode::T::SidewaysLr) {
                Side::Bottom
            } else {
                Side::Top
            },
        }
    }
    // `justify-content` as the code the layout reads: physical `left` / `right` resolved against the
    // main axis, a flow-relative keyword turned by a reversed direction.
    fn justify_code(&self, flags: style::values::specified::align::AlignFlags) -> u8 {
        let mut k = align_kw(flags);
        let mut physical = false;
        if matches!(k, Kw::Left | Kw::Right) {
            // (…themselves on a horizontal main axis, line-left / line-right on a vertical INLINE one, and nothing on a
            // vertical block axis, where they behave as `start`)
            let target = if self.main_is_x {
                Some(if k == Kw::Left { Side::Left } else { Side::Right })
            } else if !self.column {
                let opposite = if self.line_left == Side::Top { Side::Bottom } else { Side::Top };
                Some(if k == Kw::Left { self.line_left } else { opposite })
            } else {
                None
            };
            match target {
                Some(target) => {
                    k = if target == self.main_start { Kw::FlexStart } else { Kw::FlexEnd };
                    physical = true;
                }
                None => k = Kw::Start,
            }
        }
        if self.flex_reverse && !physical {
            k = match k {
                Kw::Start => Kw::FlexEnd,
                Kw::End => Kw::FlexStart,
                k => k,
            };
        }
        match k {
            Kw::Center => 1,
            Kw::End | Kw::FlexEnd | Kw::Right => 2,
            Kw::SpaceBetween => 3,
            Kw::SpaceAround => 4,
            Kw::SpaceEvenly => 5,
            _ => 0,
        }
    }
    // An item's cross alignment (PHYSICAL where `physical`): its `align-self` (`own`),
    // else the container's `align-items`, as a keyword along the cross axis — `self-start` / `self-end` by the item's
    // own flow (`own_sides`, its `flow_sides`).
    fn cross_align(&self, items: Kw, own: Kw, own_sides: [Side; 4], mode: BaselineMode, physical: bool) -> Kw {
        let align = if own != Kw::Auto { own } else { items };
        let (at_start, at_end) = if self.cross_flip { (Kw::FlexEnd, Kw::FlexStart) } else { (Kw::FlexStart, Kw::FlexEnd) };
        let a = match align {
            Kw::Normal | Kw::Auto | Kw::Left | Kw::Right | Kw::Other => Kw::Stretch,
            Kw::SelfStart | Kw::SelfEnd => {
                // (…by the item's OWN flow: its inline-start where that runs along the cross axis, else its block-start —
                // a `vertical-rl` item's right, where its inline axis runs down a row's cross axis across)
                let cross_is_x = matches!(self.cross_start, Side::Left | Side::Right);
                let [block_start, _, inline_start, _] = own_sides;
                let inline_is_x = matches!(inline_start, Side::Left | Side::Right);
                let mut side = if inline_is_x == cross_is_x { inline_start } else { block_start };
                if align == Kw::SelfEnd {
                    side = match side {
                        Side::Left => Side::Right,
                        Side::Right => Side::Left,
                        Side::Top => Side::Bottom,
                        Side::Bottom => Side::Top,
                    };
                }
                if side == self.cross_start { Kw::FlexStart } else { Kw::FlexEnd }
            }
            Kw::Start => at_start,
            Kw::End => at_end,
            Kw::LastBaseline => match mode {
                BaselineMode::Keep => Kw::LastBaseline,
                BaselineMode::Axis => Kw::FlexEnd,
                BaselineMode::Flow => at_end,
            },
            Kw::Baseline => match mode {
                BaselineMode::Keep => Kw::Baseline,
                BaselineMode::Axis => Kw::FlexStart,
                BaselineMode::Flow => at_start,
            },
            a => a,
        };
        if physical && self.cross_far {
            return match a {
                Kw::FlexStart => Kw::FlexEnd,
                Kw::FlexEnd => Kw::FlexStart,
                a => a,
            };
        }
        a
    }
    // An item's `auto` margins as the layout reads them (`flex_item_auto`): 1 main-lead, 2 main-trail, 4 cross-lead,
    // 8 cross-trail —
    // the main pair along the axis, the cross pair PHYSICALLY (top / bottom across a row, left / right across a column).
    fn auto_margin_bits(&self, auto: u8) -> u8 {
        // (`auto` is `auto_margins`' mask: 1 left, 2 right, 4 top, 8 bottom)
        let bit = |side: Side| match side {
            Side::Left => auto & 1 != 0,
            Side::Right => auto & 2 != 0,
            Side::Top => auto & 4 != 0,
            Side::Bottom => auto & 8 != 0,
        };
        let (lead, trail) = if self.main_is_x {
            if self.main_reverse { (Side::Right, Side::Left) } else { (Side::Left, Side::Right) }
        } else if self.main_reverse {
            (Side::Bottom, Side::Top)
        } else {
            (Side::Top, Side::Bottom)
        };
        let (cross_lead, cross_trail) = if self.main_is_x { (Side::Top, Side::Bottom) } else { (Side::Left, Side::Right) };
        (bit(lead) as u8) | (bit(trail) as u8) << 1 | (bit(cross_lead) as u8) << 2 | (bit(cross_trail) as u8) << 3
    }
}

// A gap as the layout resolves it: `normal` none, else its pair or program.
fn gap(v: &style::values::computed::length::NonNegativeLengthPercentageOrNormal) -> Result<Spec, &'static str> {
    use style::values::generics::length::GenericLengthPercentageOrNormal as OrNormal;
    match v {
        OrNormal::Normal => Ok(Spec { px: 0.0, frac: 0.0, prog: None }),
        OrNormal::LengthPercentage(lp) => spec(&lp.0),
    }
}

// An item's `flex-basis` as the layout resolves it against the main size (`flex_basis_cb` / `flex_basis_frac` /
// `flex_basis_math` / `flex_basis_kw`): none
// for `auto`, a keyword by its code (1 content, 2 min-content, 3 max-content, 4 fit-content), else its pair.
struct FlexBasisSpec {
    px: f64,
    frac: f64,
    prog: Option<Vec<f64>>,
    keyword: u8,
}
impl FlexBasisSpec {
    fn of(style: &ComputedValues) -> Result<FlexBasisSpec, &'static str> {
        use style::values::generics::flex::GenericFlexBasis as FlexBasis;
        use style::values::generics::length::GenericSize as Size;
        let none = |keyword| FlexBasisSpec { px: f64::NAN, frac: f64::NAN, prog: None, keyword };
        Ok(match &style.get_position().flex_basis {
            FlexBasis::Content => none(1),
            FlexBasis::Size(Size::MinContent) => none(2),
            FlexBasis::Size(Size::MaxContent) => none(3),
            FlexBasis::Size(Size::FitContent) => none(4),
            FlexBasis::Size(Size::LengthPercentage(lp)) if lp.0.has_percentage() => {
                let s = spec(&lp.0)?;
                FlexBasisSpec { px: s.px, frac: s.frac, prog: s.prog, keyword: 0 }
            }
            FlexBasis::Size(Size::LengthPercentage(lp)) => FlexBasisSpec { px: length(&lp.0)?, frac: f64::NAN, prog: None, keyword: 0 },
            // (…`stretch` fills the container's main size — the 100% it resolves to, Chrome's 300 in a 300px row before it
            // shrinks — and what is no size here, an `anchor-size()`, the `auto` it falls back to)
            FlexBasis::Size(Size::Stretch | Size::WebkitFillAvailable) => FlexBasisSpec { px: 0.0, frac: 1.0, prog: None, keyword: 0 },
            _ => none(0),
        })
    }
}

// A replaced element's intrinsic size: its figures, whether they carry a ratio, and whether ONLY the ratio does (an
// svg with a viewBox and no size).
#[derive(Clone, Copy)]
struct Intrinsic {
    w: f64,
    h: f64,
    ratio: bool,
    ratio_only: bool,
}
// A label's lines, at each line break it holds (CR LF, CR or LF: `LABEL_BREAK_RE`).
fn split_label_lines(label: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < label.len() {
        if label[i] == 0x0D || label[i] == 0x0A {
            lines.push(&label[start..i]);
            i += if label[i] == 0x0D && label.get(i + 1) == Some(&0x0A) { 2 } else { 1 };
            start = i;
        } else {
            i += 1;
        }
    }
    lines.push(&label[start..]);
    lines
}
// Text collapsed as a line start (`collapseRun(text, el, true)`): a preserving mode drops its newlines, any other runs
// of white space to one space, none leading.
fn collapse_run(text: &[u16], mode: u8) -> Vec<u16> {
    if preserving(mode) {
        return text.iter().copied().filter(|&u| !matches!(u, 0x0A | 0x0D | 0x0C)).collect();
    }
    let mut out = Vec::with_capacity(text.len());
    for &u in text {
        if matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C) {
            if !out.is_empty() && out.last() != Some(&0x20) {
                out.push(0x20);
            } else if out.is_empty() {
                continue;
            }
        } else {
            out.push(u);
        }
    }
    out
}
// An svg `width` / `height` attribute: a number of px, `em` or `rem` (`svgAttrLength`).
fn svg_length(v: &str, em: f64, rem: f64) -> Option<f64> {
    let t = v.trim();
    let (num, unit) = match t.find(|c: char| c.is_ascii_alphabetic()) {
        Some(i) => (&t[..i], t[i..].to_ascii_lowercase()),
        None => (t, String::new()),
    };
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit() || c == '.') || num.matches('.').count() > 1 || num.ends_with('.') {
        return None;
    }
    let n: f64 = num.parse().ok()?;
    match unit.as_str() {
        "" | "px" => Some(n),
        "em" => Some(n * em),
        "rem" => Some(n * rem),
        _ => None,
    }
}
// An svg `viewBox`: its width and height, where all four numbers are and both are positive (`parseViewBox`).
fn view_box(v: &str) -> Option<(f64, f64)> {
    let n: Vec<f64> = v.trim().split(|c: char| c.is_whitespace() || c == ',').filter(|p| !p.is_empty()).map(|p| p.parse::<f64>()).collect::<Result<_, _>>().ok()?;
    (n.len() == 4 && n.iter().all(|v| v.is_finite()) && n[2] > 0.0 && n[3] > 0.0).then_some((n[2], n[3]))
}

// A table's structure (`tableGrid`): its rows in render order, its groups, captions, columns and out-of-flow children,
// and how many columns it has.
struct TableGrid {
    // (…the table's element — None for an ANONYMOUS table around misparented table boxes (CSS 2.1 §17.2.1), which has
    // none — and the element whose style it inherits and whose alignment its cells take: the table, or the block the
    // anonymous one is in)
    table: Option<NodeId>,
    container: NodeId,
    rows: Vec<GridRow>,
    groups: Vec<GridGroup>,
    captions: Vec<NodeId>,
    columns: Vec<NodeId>,
    // (…and each `<colgroup>` that defines its columns through `<col>` children, with them: its own border collapses
    // at the group's rim)
    column_groups: Vec<(NodeId, Vec<NodeId>)>,
    oof: Vec<NodeId>,
    col_count: usize,
}
// A row — an element's, or an anonymous one around stray content — its group, its content, and its cells placed.
struct GridRow {
    el: Option<NodeId>,
    group: Option<usize>,
    nodes: Vec<NodeId>,
    pending: Vec<CellEl>,
    cells: Vec<GridCell>,
}
struct GridGroup {
    el: NodeId,
    index: usize,
    first: i32,
    last: i32,
    // (…0 header, 1 body, 2 footer: the order a table renders its groups in, `rowGroupRankOf`)
    rank: u8,
}
#[derive(Clone)]
enum CellEl {
    El(NodeId),
    Anon(Vec<NodeId>),
}
struct GridCell {
    el: CellEl,
    col: usize,
    col_span: usize,
    row_span: usize,
    // (…in a collapsing table, the half-borders the grid resolves for it, top right bottom left)
    halves: Option<[f64; 4]>,
}
// A `span` / `colspan` / `rowspan` attribute (`spanAttr`): its integer, clamped to at least `min` (1 where `min` is 0 and
// there is none) and at most 1000.
fn span_attr(raw: Option<&str>, min: usize) -> usize {
    let fallback = if min > 0 { min } else { 1 };
    let Some(raw) = raw else { return fallback };
    // (…JavaScript's `parseInt`: leading white space and a sign, then digits)
    let t = raw.trim_start();
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return fallback;
    }
    // (…past 1000 the count is 1000, however many digits say so)
    let significant = t[..digits].trim_start_matches('0');
    let n = if significant.len() > 4 { usize::MAX } else { significant.parse::<usize>().unwrap_or(0) };
    if neg && n > 0 {
        return fallback;
    }
    n.max(min).min(1000)
}
// A box's four sides as a collapsing table weighs them (`collapseSideW`), top right bottom left: the used width, 0 for
// `none`, and -1 for `hidden`, which suppresses whatever edge it meets on.
fn collapse_sides(style: &ComputedValues) -> [f64; 4] {
    use style::values::specified::BorderStyle;
    let bd = style.get_border();
    let side = |w: &style::values::computed::BorderSideWidth, s: BorderStyle| match s {
        BorderStyle::Hidden => -1.0,
        BorderStyle::None => 0.0,
        _ => w.0.to_f64_px(),
    };
    [
        side(&bd.border_top_width, bd.border_top_style),
        side(&bd.border_right_width, bd.border_right_style),
        side(&bd.border_bottom_width, bd.border_bottom_style),
        side(&bd.border_left_width, bd.border_left_style),
    ]
}
// Two borders meeting on one edge (`combineW`): a `hidden` either side suppresses it, else the wider wins.
fn combine(a: f64, b: f64) -> f64 {
    if a < 0.0 || b < 0.0 { -1.0 } else { a.max(b) }
}
// The half of an edge a box owns: none of a suppressed one.
fn half(w: f64) -> f64 {
    if w < 0.0 { 0.0 } else { w / 2.0 }
}
// A grid's column template as the layout takes it: the tracks with an `auto-fill` / `auto-fit`
// repeat left as ONE copy — where it starts, how long it is, and 1 fill / 2 fit (-1, 0, 0 for none) — and a literal
// `repeat(N, …)` expanded. `none` is one implicit column the full width.
struct GridTemplate {
    tracks: Vec<GridTrack>,
    repeat_start: f64,
    repeat_len: f64,
    repeat_kind: f64,
}
// One track: a length and / or a percentage (a linear `calc()` is both), an `fr`, a keyword, a
// `fit-content()` cap, and the floor a `minmax()` gives it.
#[derive(Clone, Default)]
struct GridTrack {
    px: Option<f64>,
    frac: Option<f64>,
    // (…or, for a comparison or math function over a percentage, its PROGRAM, resolved against the content width)
    prog: Option<Vec<f64>>,
    fr: Option<f64>,
    auto: bool,
    min: bool,
    max: bool,
    fit: Option<Box<GridTrack>>,
    floor: Option<Box<GridTrack>>,
}
impl GridTemplate {
    fn of(v: &style::values::computed::GridTemplateComponent) -> Result<GridTemplate, &'static str> {
        use style::values::generics::grid::{GenericGridTemplateComponent as Template, RepeatCount, TrackListValue};
        let implicit = || GridTemplate {
            tracks: vec![GridTrack { frac: Some(1.0), ..Default::default() }],
            repeat_start: -1.0,
            repeat_len: 0.0,
            repeat_kind: 0.0,
        };
        let list = match v {
            Template::None => return Ok(implicit()),
            Template::TrackList(list) => list,
            // (…a `subgrid` takes its parent's tracks — `Walk::subgrid_columns` — and is `none` where it has no grid
            // to join; `masonry` is unratified)
            _ => return Ok(implicit()),
        };
        let mut out = GridTemplate { tracks: Vec::new(), repeat_start: -1.0, repeat_len: 0.0, repeat_kind: 0.0 };
        for value in list.values.iter() {
            match value {
                TrackListValue::TrackSize(size) => match GridTrack::of(size) {
                    Some(t) => out.tracks.push(t),
                    None => return Ok(implicit()),
                },
                TrackListValue::TrackRepeat(repeat) => {
                    let body: Option<Vec<GridTrack>> = repeat.track_sizes.iter().map(GridTrack::of).collect();
                    let Some(body) = body else { return Ok(implicit()) };
                    let copies = match repeat.count {
                        RepeatCount::Number(n) => n.max(1) as usize,
                        RepeatCount::AutoFill | RepeatCount::AutoFit => {
                            out.repeat_start = out.tracks.len() as f64;
                            out.repeat_len = body.len() as f64;
                            out.repeat_kind = if matches!(repeat.count, RepeatCount::AutoFill) { 1.0 } else { 2.0 };
                            1
                        }
                    };
                    for _ in 1..copies {
                        out.tracks.extend(repeat.track_sizes.iter().filter_map(GridTrack::of));
                    }
                    out.tracks.extend(body);
                }
            }
        }
        Ok(if out.tracks.is_empty() { implicit() } else { out })
    }
}
impl GridTrack {
    // A length and nothing else: the track's size in px.
    fn fixed(&self) -> Option<f64> {
        let plain = self.frac.is_none() && self.prog.is_none() && self.fr.is_none() && !self.auto && !self.min && !self.max;
        self.px.filter(|_| plain && self.fit.is_none() && self.floor.is_none())
    }
    fn of(size: &style::values::computed::TrackSize) -> Option<GridTrack> {
        use style::values::generics::grid::GenericTrackSize as Size;
        match size {
            Size::Breadth(b) => GridTrack::breadth(b),
            Size::Minmax(min, max) => {
                let mut t = GridTrack::breadth(max)?;
                t.floor = Some(Box::new(GridTrack::breadth(min)?));
                Some(t)
            }
            Size::FitContent(cap) => Some(GridTrack { fit: Some(Box::new(GridTrack::breadth(cap)?)), ..Default::default() }),
        }
    }
    fn breadth(b: &style::values::computed::TrackBreadth) -> Option<GridTrack> {
        use style::values::generics::grid::GenericTrackBreadth as Breadth;
        Some(match b {
            Breadth::Breadth(lp) => {
                let s = spec(lp).ok()?;
                if s.prog.is_some() {
                    GridTrack { prog: s.prog, ..Default::default() }
                } else if lp.has_percentage() {
                    GridTrack { px: Some(s.px), frac: Some(s.frac), ..Default::default() }
                } else {
                    GridTrack { px: Some(s.px), ..Default::default() }
                }
            }
            Breadth::Flex(fr) => GridTrack { fr: Some(f32_exact(fr.0)), ..Default::default() },
            Breadth::Auto => GridTrack { auto: true, ..Default::default() },
            Breadth::MinContent => GridTrack { min: true, ..Default::default() },
            Breadth::MaxContent => GridTrack { max: true, ..Default::default() },
        })
    }
    // One side of the track as native resolves it, `[kind, value, px]`: 0 a length, 1 the column's min-content, 2 its
    // max-content, 3 `fit-content` capped at a length, 4 a fraction of the grid's content width beside a length, 5
    // `fit-content` capped at such a fraction, 6 a program of the pass's math table (its offset, `math` enters it) at
    // the content width, 7 `fit-content` capped at such a program. `min` asks the base's question, else the limit's.
    fn side(&self, min: bool, math: &mut impl FnMut(&[f64]) -> u32) -> [f64; 3] {
        const SIDE_MIN: [f64; 3] = [1.0, 0.0, 0.0];
        const SIDE_MAX: [f64; 3] = [2.0, 0.0, 0.0];
        if let Some(prog) = &self.prog {
            return [6.0, math(prog) as f64, 0.0];
        }
        if let Some(frac) = self.frac {
            return [4.0, frac, self.px.unwrap_or(0.0)];
        }
        if let Some(px) = self.px {
            return [0.0, px, 0.0];
        }
        if let Some(cap) = &self.fit {
            if min {
                return SIDE_MIN;
            }
            if let Some(prog) = &cap.prog {
                return [7.0, math(prog) as f64, 0.0];
            }
            return match (cap.frac, cap.px) {
                (Some(frac), px) => [5.0, frac, px.unwrap_or(0.0)],
                (None, Some(px)) => [3.0, px, 0.0],
                (None, None) => [3.0, f64::INFINITY, 0.0],
            };
        }
        if self.min {
            return SIDE_MIN;
        }
        if self.max {
            return SIDE_MAX;
        }
        if min { SIDE_MIN } else { SIDE_MAX }
    }
}
// The height of a grid's auto rows: its `grid-auto-rows` where that is one plain length, else None —
// a `minmax()`, a `fit-content()`, a list and a percentage are content rows here.
fn grid_row_height(rows: &style::values::computed::ImplicitGridTracks) -> Option<f64> {
    use style_traits::ToCss;
    let text = rows.to_css_string();
    text.strip_suffix("px").and_then(|v| v.parse::<f64>().ok()).filter(|&v| v >= 0.0)
}
// …and the floor a content row keeps: the length a single `minmax(<length>, <anything else>)` names.
fn grid_row_floor(rows: &style::values::computed::ImplicitGridTracks) -> Option<f64> {
    use style::values::generics::grid::{GenericTrackBreadth as Breadth, GenericTrackSize as Size};
    let [Size::Minmax(Breadth::Breadth(min), max)] = &rows.0[..] else { return None };
    if min.has_percentage() || matches!(max, Breadth::Breadth(lp) if !lp.has_percentage()) {
        return None;
    }
    min.to_length().map(|l| f32_exact(l.px()))
}
// An item's declared column lines: its start and end LINE numbers (0 for `auto` or a name) and
// an explicit `span N` (0 for none).
fn grid_column_placement(style: &ComputedValues) -> [f64; 3] {
    let pos = style.get_position();
    let line = |l: &style::values::computed::GridLine| if l.is_span || !l.ident.0.is_empty() { 0.0 } else { l.line_num as f64 };
    // (…a span to a NAMED line is none: `span b` counts no lines here, in either walk)
    // (…a span of ONE is no span, whatever line it names — it places the item as one column either way, and `span b` is
    // `span 1 b` to the style engine)
    let span = |l: &style::values::computed::GridLine| if l.is_span && l.line_num > 1 { l.line_num as f64 } else { 0.0 };
    let (start, end) = (&pos.grid_column_start, &pos.grid_column_end);
    [line(start), line(end), if span(start) != 0.0 { span(start) } else { span(end) }]
}
// A plain percentage — `50%`, no math function — as its fraction.
fn plain_percentage(lp: &LengthPercentage) -> Option<f64> {
    use style::values::computed::length_percentage::Unpacked;
    match lp.unpack() {
        Unpacked::Percentage(p) => Some(f32_exact(p.0)),
        _ => None,
    }
}
// How a cell's content sits in its row-tall box: 0 baseline, 1 top, 2 middle, 3 bottom.
fn cell_valign(style: &ComputedValues) -> u8 {
    use style::values::generics::box_::{BaselineShiftKeyword, GenericBaselineShift as BaselineShift};
    use style::values::specified::box_::AlignmentBaseline;
    let b = style.get_box();
    match (&b.baseline_shift, b.alignment_baseline) {
        (BaselineShift::Keyword(BaselineShiftKeyword::Top), _) => 1,
        (BaselineShift::Keyword(BaselineShiftKeyword::Bottom), _) => 3,
        (_, AlignmentBaseline::Middle) => 2,
        _ => 0,
    }
}
// Is a text node white space alone to JavaScript's `trim` (the white space and line terminators it strips)?
fn js_trim_empty(text: &[u16]) -> bool {
    text.iter().all(|&u| matches!(u, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF))
}

// A flex item: an element, or an anonymous one around a run of bare text.
enum FlexItem {
    Element(NodeId),
    // (…and which of the container's anonymous items it is, counted in document order: what names it to the JS side,
    // whose `boxItems` counts the same one)
    Anonymous(Vec<NodeId>, u32),
}

// A resolved `vertical-align`: its mode and the shift it carries.
#[derive(Clone, Copy)]
struct Va {
    mode: VaMode,
    px: f64,
}
#[derive(Clone, Copy, PartialEq)]
enum VaMode {
    Shift,
    Top,
    Bottom,
    Middle,
    TextTop,
    TextBottom,
    // `-webkit-baseline-middle`: the box's own middle on the baseline
    BaselineMiddle,
}

// What `record_as` settles about a box before its record is built: its `clear` (0 none, 1 left, 2
// right, 3 both), whether that gives it clearance, which side it floats to (0 none, 1 left, 2 right), and whether it
// establishes a formatting context.
struct Fresh {
    clear: u8,
    separates: bool,
    floated: u8,
    bfc: bool,
}

// What a record is to the box that walks it: a box in flow, an out-of-flow one, a cell or a caption a table lays out.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    Flow,
    OutOfFlow,
    Cell,
    Caption,
}

// What a block's element child is to its flow.
#[derive(Clone, Copy, PartialEq)]
enum Kid {
    Block,
    Float,
    OutOfFlow,
    // (…the first of a run of table boxes with no table around them — the `n`th of the block's anonymous tables — and
    // one of the rest of it)
    Table(usize),
    InTable,
}

// Where the streams stood, for an attempt to be taken back to.
#[derive(Clone)]
struct Mark {
    inputs: usize,
    anon: usize,
    runs: usize,
    entries: usize,
    inlines: usize,
    maths: usize,
    math_index: usize,
    saw_float: (bool, bool),
}

// A text block's inline content as its gather builds it: the block's style (its tab stops, what an inline's font is
// taken against), the runs so far, and whether any of them makes a line.
struct Gather<'s> {
    block: &'s ComputedValues,
    // (…the text block's record, which an out-of-flow box among the lines hangs under)
    idx: i32,
    runs: Vec<Pending>,
    makes_line: bool,
    // (…the floats among them, which an anonymous run that makes no line hands back to its block)
    floats: Vec<NodeId>,
    // The `position: relative` offsets of the inline boxes the gather is inside, summed.
    rel: Option<Rel>,
}

// A chain of relative offsets as the layout resolves it against the block laying the lines out: `x + xf × W` across, and
// down `y + yf × H` where H is definite and `yi` where it is not, with a comparison's share as a program per axis.
#[derive(Clone, Default)]
struct Rel {
    x: f64,
    xf: f64,
    y: f64,
    yf: f64,
    yi: f64,
    xm: Option<Vec<f64>>,
    ym: Option<Vec<f64>>,
}

impl Rel {
    fn plus(&self, o: &Rel) -> Rel {
        let sum = |a: &Option<Vec<f64>>, b: &Option<Vec<f64>>| match (a, b) {
            (Some(a), Some(b)) => Some([&a[..], &b[..], &[MATH_SUM, 0.0, 0.0]].concat()),
            (a, b) => a.clone().or_else(|| b.clone()),
        };
        Rel {
            x: self.x + o.x,
            xf: self.xf + o.xf,
            y: self.y + o.y,
            yf: self.yf + o.yf,
            yi: self.yi + o.yi,
            xm: sum(&self.xm, &o.xm),
            ym: sum(&self.ym, &o.ym),
        }
    }
}

// A run before its block commits it: its inline box is named by the gather's entry, tabled at the commit.
enum Pending {
    // (…with the element each part of it was written in, as `[(offset, nid)]` — the painter's colour and font)
    // (…and, in a `unicode-range` split, the ascent and descent its characters' faces need: `split_vmax`)
    Text { font: FontInfo, text: Vec<u16>, wrap: u8, ws: u8, shift: f64, vmax: Option<(f64, f64)>, owners: Vec<(u32, f64)> },
    Open { plain: f64, ws: u8, entry: usize },
    Close { plain: f64, ws: u8, entry: usize, lands: bool, own_h: f64, own_asc: f64 },
    Br { ws: u8, clear: u8, entry: usize },
    Wbr { ws: u8, entry: usize },
    // An out-of-flow box's static position: where the flow reached it, on this line.
    Oof { ws: u8, rec: i32, rel: Option<Rel> },
    // A float, placed where the lines reach it.
    Float { ws: u8, rec: i32 },
    // An atomic inline, hung by its `vertical-align`: a baseline shift, an alignment against the parent's font (its
    // code and the parent-font figure it reads), or a line-relative mode (1 top, 2 bottom).
    Atomic { ws: u8, rec: i32, shift: f64, code: u8, figure: f64, line_mode: u8 },
}

// An inline box's edges as its entry and its runs carry them (`Walk::entry`): the margins, the border + padding
// sides, the borders, each side's fraction of the
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

// A block's font as its runs and its line box take it.
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
    // Whether `face` splits a run's characters across faces by `unicode-range` — then a run's line box is the deepest
    // its characters select (`split_vmax`).
    split: bool,
}

// The white-space modes a record and a run carry.
const WS_NORMAL: u8 = 0;
const WS_NOWRAP: u8 = 1;
const WS_PRE: u8 = 2;
const WS_PRE_WRAP: u8 = 3;
const WS_PRE_LINE: u8 = 4;
const WS_BREAK_SPACES: u8 = 5;

// The elements HTML gives a formatting context of their own whatever their `display`: the widgets and the replaced
// elements.
const OWN_CONTEXT_TAGS: &[&str] = &[
    "button", "input", "select", "textarea", "fieldset", "meter", "progress", "marquee", "img", "canvas", "video", "audio",
    "object", "embed", "iframe", "frame", "svg",
];
// Whether an element has an INTRINSIC size — a replaced element or a control, sized from data or UA rules — which is
// what makes a box replaced: by its tag, but an `<object>` showing its fallback content is no replaced element at all.
pub(crate) fn replaced_or_control(arena: &RealmArena, id: NodeId, node: &crate::dom::NodeData) -> bool {
    match node.rendering_tag() {
        "object" => !renders_object_fallback(arena, id, node),
        tag => matches!(
            tag,
            "input" | "select" | "textarea" | "meter" | "progress" | "img" | "canvas" | "video" | "audio" | "embed" | "iframe"
                | "frame" | "svg"
        ),
    }
}
// An `<object>` that renders its FALLBACK content — its children, as the box its own style makes it — rather than a
// resource (`rendersObjectFallback`): one with no `data` and some content, an element or text that is not white space.
fn renders_object_fallback(arena: &RealmArena, id: NodeId, node: &crate::dom::NodeData) -> bool {
    node.get_attr("data").is_none()
        && arena.get(id).is_some_and(|n| {
            n.children.iter().filter_map(|&c| arena.get(c)).any(|c| c.kind == NodeKind::Element || (c.kind == NodeKind::Text && has_content(&c.data)))
        })
}
// …and HTML's WIDGETS, whose box the UA decides however the page spells a block-level `display` (a
// `<button style="display: table">` is a flow-root block).
pub(crate) fn widget_tag(tag: &str) -> bool {
    matches!(tag, "button" | "input" | "select" | "textarea" | "fieldset" | "meter" | "progress" | "marquee")
}

impl<'a> Walk<'a> {
    // A record goes in — and where each stream stands as it does (`Extent`).
    fn push_record(&mut self, rec: Input) {
        self.extents.push(Extent { start: self.stream_ends(), end: None, ctx: None, saw_out: (false, false) });
        self.inputs.push(rec);
    }
    // Where the run, grid and inline streams stand.
    fn stream_ends(&self) -> [usize; 3] {
        [self.runs.len(), self.grids.len(), self.inlines.len()]
    }

    // The root element's box. A floated or absolutely positioned root is no float and no out-of-flow box of anything —
    // there is nothing around it — but it is sized and placed as one in the viewport: shrink-to-fit, at the side it
    // floats to, or by its insets as an absolutely positioned box is (Chrome: `html { position: absolute; top: 10px;
    // left: 20px }` holding "hello world" is 121.61 wide at (20, 10); with `inset: 0` it is the viewport).
    fn root(&mut self, root: NodeId) -> Step {
        let style = self.style(root)?;
        let b = style.get_box();
        let positioned = matches!(b.clone_position(), Position::Absolute | Position::Fixed);
        self.record(root, -1)?;
        let fits = if positioned {
            crate::layout::ROOT_POSITIONED
        } else {
            match b.clone_float() {
                Float::None => return Ok(()),
                Float::Right | Float::InlineEnd if !starts_at_right(&style) => crate::layout::ROOT_FLOAT_RIGHT,
                Float::Left | Float::InlineStart if starts_at_right(&style) => crate::layout::ROOT_FLOAT_RIGHT,
                _ => crate::layout::ROOT_FLOAT_LEFT,
            }
        };
        let (w, h) = (self.basis.w, self.basis.h);
        let pos = style.get_position();
        let mut insets = [f64::NAN; 4];
        if positioned {
            for (k, (inset, basis)) in [(&pos.top, h), (&pos.right, w), (&pos.bottom, h), (&pos.left, w)].into_iter().enumerate() {
                if let Some(lp) = inset_lp(inset)? {
                    insets[k] = lp.resolve(style::values::computed::Length::new(basis as f32)).px() as f64;
                }
            }
        }
        let r = &mut self.inputs[0];
        r.fits_content = fits;
        [r.inset_top, r.inset_right, r.inset_bottom, r.inset_left] = insets;
        r.cb_rect = [0.0, 0.0, w, h];
        Ok(())
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

    // A node's style: an element's, or a generated box's — its element's `::before` / `::after`.
    fn style(&self, id: NodeId) -> Result<Arc<ComputedValues>, &'static str> {
        match self.generated.box_info(id) {
            Some((origin, which, _)) => crate::style::eager_pseudo(self.arena, origin, &PSEUDOS[which]).ok_or("unstyled"),
            None => crate::style::primary_style(self.arena, id).ok_or("unstyled"),
        }
    }

    // A node the walk lays out: the arena's, or the text a generated box holds.
    fn get(&self, id: NodeId) -> Option<&'a crate::dom::NodeData> {
        if id.generation == GENERATED_TEXT {
            return self.generated.text(id);
        }
        self.arena.get(id)
    }
    fn node(&self, id: NodeId) -> &'a crate::dom::NodeData {
        self.get(id).expect("a walked node is live")
    }
    // …and its parent in the FLAT tree (`flatTreeParent`, the style engine's `traversal_parent`): a slotted node's slot,
    // a shadow tree's top-level node's host — none for a host's child no slot takes — and a generated box's the
    // element it is of, which no tree says.
    fn parent_of(&self, id: NodeId) -> Option<NodeId> {
        if let Some((origin, ..)) = self.generated.box_info(id) {
            return Some(origin);
        }
        // (…a generated box's text, which the arena does not hold, is its box's)
        if id.generation == GENERATED_TEXT {
            return self.node(id).parent;
        }
        crate::geometry::flat_parent(self.arena, id)
    }

    // The element's children the flow lays out, in order (`layoutChildren`) — its FLAT tree's: a host's shadow tree, a
    // slot's assigned nodes (its own children where it has none) — its `::before` box first and its `::after` box last,
    // and a generated box's, its text. A
    // `display: contents` child generates NO box: it is replaced by its own children, in its place (CSS Display 3
    // §3.1), so the plain name is the one that looks through — every box-level enumeration asks it.
    fn children(&self, id: NodeId) -> std::vec::IntoIter<NodeId> {
        let mut out = Vec::new();
        self.push_children(id, &mut out);
        out.into_iter()
    }
    fn push_children(&self, id: NodeId, out: &mut Vec<NodeId>) {
        let (first, kids, last) = match self.generated.box_info(id) {
            Some((.., text)) => (text, &[][..], None),
            None => {
                let [before, after] = self.generated.boxes_of(id);
                (before, flat_children(self.arena, self.node(id)), after)
            }
        };
        for c in first.into_iter().chain(kids.iter().copied().filter(|&c| self.arena.get(c).is_some())).chain(last) {
            if self.not_rendered(c) {
                continue;
            }
            if self.boxless(c) {
                self.push_children(c, out);
            } else {
                out.push(c);
            }
        }
    }
    // An element no UA renders though its style says it is there (`uaNotRendered`): an `<embed>` with no resource, which
    // Chrome gives no box at all while its computed `display` stays `inline` — so it is no child of any box here.
    fn not_rendered(&self, c: NodeId) -> bool {
        let n = self.node(c);
        n.rendering_tag() == "embed" && n.get_attr("src").is_none()
    }
    // The `white-space` a text node collapses by: the box-less element's it is spliced out of where it is (the one
    // inherited property it takes from there that decides whether its white space is content), else `ws_mode`, its box's.
    fn text_ws_mode(&self, c: NodeId, ws_mode: u8) -> Result<u8, &'static str> {
        match self.parent_of(c).filter(|&p| self.boxless(p)) {
            Some(p) => ws_mode_of(&*self.style(p)?),
            None => Ok(ws_mode),
        }
    }
    // Is `c` an element that generates no box of its own, but whose children stand in for it (`display: contents`)?
    fn boxless(&self, c: NodeId) -> bool {
        self.node(c).kind == NodeKind::Element && self.style(c).is_ok_and(|s| s.get_box().walk_display(self.node(c).rendering_tag()).is_contents())
    }
    // …and the box that lays an element out: its nearest ancestor that generates one (`layoutParent`).
    fn layout_parent(&self, id: NodeId) -> Option<NodeId> {
        let mut p = self.parent_of(id);
        while let Some(at) = p.filter(|&at| self.boxless(at)) {
            p = self.parent_of(at);
        }
        p
    }

    // How a rendered legend sits across its fieldset (`Input::legend_align`): by its `justify-self`
    // where that is `left` / `center` / `right`, by its margins otherwise; 0 for any other element.
    fn legend_align(&self, id: NodeId, style: &ComputedValues) -> u8 {
        use style::values::specified::align::AlignFlags;
        if !self.rendered_legend(id) {
            return 0;
        }
        match style.get_position().justify_self.0.value() {
            AlignFlags::LEFT => 2,
            AlignFlags::CENTER => 3,
            AlignFlags::RIGHT => 4,
            _ => 1,
        }
    }

    // Whether `id` is a fieldset's RENDERED LEGEND (HTML §15.3.13, geometry.rs `rendered_legend`): the first child BOX of the
    // fieldset's box that is a `<legend>`, neither floated nor absolutely positioned — so one that generates no box is
    // passed over, one reached through a `display: contents` wrapper or a slot counts, and a box-less fieldset has none.
    fn rendered_legend(&self, id: NodeId) -> bool {
        crate::geometry::rendered_legend(self.arena, id)
    }

    // The display the walk lays the element `id` out by (`WalkDisplay`) — and a fieldset's RENDERED legend blockified
    // whatever inline-level display it declares, as HTML lays it out (Chrome: `display: inline; width: 100px` is 104 wide
    // and an `auto` margin pushes it across): its own width and margins apply, as a block's do.
    // (…not asked by `boxless`, which `rendered_legend` walks the fieldset's children through: whether a box is
    // `contents` no blockification changes)
    // …and no table box what can be none: a REPLACED element or a control with a table display is an inline-level box
    // (CSS Tables 3 §2.1, "a breaking change from CSS 2.1 but matches implementations" — Chrome and Firefox put an
    // `<img style="display: table-cell">` on the line, 20 x 20), and a `<button>` or a `<fieldset>` the flow-root
    // block HTML lays one out as whatever display is not inline-level.
    fn laid_display(&self, id: NodeId, b: &style::properties::style_structs::Box) -> Display {
        let node = self.node(id);
        let d = b.walk_display(node.rendering_tag());
        // (…a table display included: no anonymous table takes a rendered legend in)
        if matches!(d.outside(), DisplayOutside::Inline | DisplayOutside::InternalTable | DisplayOutside::TableCaption)
            && node.is_html_named("legend")
            && self.rendered_legend(id)
        {
            return d.equivalent_block_display(false);
        }
        if matches!(d.outside(), DisplayOutside::InternalTable | DisplayOutside::TableCaption) {
            if replaced_or_control(self.arena, id, node) {
                return Display::InlineBlock;
            }
            if widget_tag(node.rendering_tag()) {
                return Display::Block;
            }
        }
        d
    }

    // One element's record, and its subtree's — an in-flow box's, or an out-of-flow one's that `oof`
    // emits.
    fn record(&mut self, id: NodeId, parent: i32) -> Step {
        self.record_as(id, parent, Role::Flow)
    }
    fn record_as(&mut self, id: NodeId, parent: i32, role: Role) -> Step {
        // Whether a float is already placed in the formatting context this box is in, per side, is the walk's own
        // document-order state (`Fresh`): a box whose `clear` names such a side has CLEARANCE, and does not
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
        // (…the root is no float, whatever it declares: `root`)
        let floated = if parent < 0 { 0 } else { self.float_code(id, &style)? };
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
        let at = self.inputs.len();
        let done = self.record_body(id, parent, role, Fresh { clear, separates, floated, bfc });
        if bfc {
            self.saw_float = outer;
        }
        if done.is_ok() && at < self.inputs.len() {
            let [runs, grids, inls] = self.stream_ends();
            self.extents[at].end = Some([self.inputs.len(), runs, grids, inls]);
            self.extents[at].saw_out = self.saw_float;
        }
        done
    }
    fn record_body(&mut self, id: NodeId, parent: i32, role: Role, fresh: Fresh) -> Step {
        let out_of_flow = role == Role::OutOfFlow;
        let node = self.node(id);
        let style = self.style(id)?;
        let tag = node.rendering_tag();
        // (…an `<svg>` in HTML is a replaced element here, the SVG inside it its own business; any other element is the
        // box its style makes it — `rendering_tag` — MathML's included: its `display: math` is no value the style engine
        // has, so a MathML element is the inline its style makes it, a `display=block` `<math>` a block (ua.css), as
        // MathML Core's math boxes are on the line or a line of their own)
        let b = style.get_box();
        let display = self.laid_display(id, b);
        // (…a block container: a block-level one, or an `inline-block`, which the gather walks as an ATOMIC)
        // (…a widget's block-level displays other than flex and grid are a flow-root block's, `WIDGET_BLOCK_DISPLAYS`)
        let widget_block = widget_tag(tag)
            && !matches!(display.outside(), DisplayOutside::Inline)
            && !matches!(display.inside(), DisplayInside::Flex | DisplayInside::Grid);
        // (…and a REPLACED element — a control, an image, a frame — is a box of its own intrinsic size, whatever it holds)
        let intrinsic = self.intrinsic(id)?;
        // (…a cell or a caption only where a table lays it out, as the walk's role for it says)
        let container = intrinsic.is_some() || widget_block || match (role, display.outside()) {
            (Role::Cell, _) => matches!(display.inside(), DisplayInside::TableCell),
            (Role::Caption, _) => matches!(display.outside(), DisplayOutside::TableCaption),
            (_, DisplayOutside::Block) => matches!(display.inside(), DisplayInside::Flow | DisplayInside::FlowRoot | DisplayInside::Flex | DisplayInside::Grid | DisplayInside::Table),
            (_, DisplayOutside::Inline) => match display.inside() {
                DisplayInside::FlowRoot | DisplayInside::Flex | DisplayInside::Grid | DisplayInside::Table => true,
                DisplayInside::Flow => self.holds_block_level(id)?,
                _ => false,
            },
            _ => false,
        };
        if !container {
            return Err(display_decline(display));
        }
        let position = b.clone_position();
        if parent >= 0 && matches!(position, Position::Absolute | Position::Fixed) != out_of_flow {
            return Err("positioned");
        }
        let idx = self.inputs.len() as i32;
        let mut rec = fresh_record();
        rec.nid = id.to_f64();
        rec.parent = parent;
        rec.run_start = -1;
        rec.flex_shrink = 1.0;
        // A FLEX ITEM's own sizing declarations (`flex_basis`, `flex_grow`, `flex_shrink`): its `flex-basis` as a length
        // (none at no basis), its factors.
        if role == Role::Flow && self.flex_item(id)? {
            let p = style.get_position();
            use style::values::generics::flex::GenericFlexBasis as FlexBasis;
            use style::values::generics::length::GenericSize as Size;
            rec.flex_basis = match &p.flex_basis {
                FlexBasis::Size(Size::LengthPercentage(lp)) if !lp.0.has_percentage() => length(&lp.0)?,
                _ => f64::NAN,
            };
            rec.flex_grow = f32_exact(p.flex_grow.0);
            rec.flex_shrink = f32_exact(p.flex_shrink.0);
        }
        let pos = style.get_position();
        rec.border_box = pos.box_sizing == BoxSizing::BorderBox;
        rec.decl_border_box = rec.border_box;
        // The six sizes: a length as itself; one with a percentage in it resolved here against the pass root's
        // containing block where the record is the ROOT's (the layout is handed no basis for it), and anywhere else
        // handed to the layout as the pair — or the program — it resolves at the basis it has.
        // (…a CELL's percentage sizes are none of its box's: its column takes a width's, a height's resolves against no
        // basis until its row does, as for every part a table lays out)
        let native_basis = parent >= 0 && role != Role::Cell;
        let edge_basis = parent >= 0;
        // An intrinsic-size KEYWORD width (`width_kw`: 1 min-content, 2 max-content, 3 fit-content) — not on the pass
        // root, sized from the width it is handed with no parent to mark it measured.
        use style::values::generics::length::GenericSize as Size;
        rec.width_kw = match pos.width {
            // (…a fieldset's RENDERED LEGEND sizes an auto width as `fit-content`, shrink-to-fit whatever its display —
            // `isRenderedLegend`)
            Size::Auto if self.rendered_legend(id) => 3,
            // (…an `anchor-size()` is no size either, `size_lp`)
            Size::Auto | Size::LengthPercentage(_) | Size::AnchorSizeFunction(_) | Size::AnchorContainingCalcFunction(_) => 0,
            Size::MinContent => 1,
            Size::MaxContent => 2,
            Size::FitContent => 3,
            // (…`stretch`, in either spelling, is taken for an auto width, which is what it is for a block in normal
            // flow — filling its containing block — and not for a flex item or an out-of-flow box: a gap)
            Size::Stretch | Size::WebkitFillAvailable => 0,
            // (…and `fit-content(<length>)` the `auto` Chrome and Firefox give it, which take the declaration for invalid:
            // CSS Sizing 3's min(max-content, max(min-content, <length>)) wants its argument on the record, which has none)
            Size::FitContentFunction(_) => 0,
        };
        rec.height_kw = matches!(pos.height, Size::MinContent | Size::MaxContent | Size::FitContent);
        rec.is_button = tag == "button";
        let sizes: [(Option<&LengthPercentage>, f64); 6] = [
            (size_lp(&pos.width), self.basis.w),
            (size_lp(&pos.height), self.basis.h),
            (size_lp(&pos.min_width), self.basis.w),
            (max_size_lp(&pos.max_width), self.basis.w),
            (size_lp(&pos.min_height), self.basis.h),
            (max_size_lp(&pos.max_height), self.basis.h),
        ];
        let mut slots = [f64::NAN; 6];
        for (k, (lp, basis)) in sizes.iter().enumerate() {
            let Some(lp) = lp else { continue };
            if !lp.has_percentage() {
                slots[k] = length(lp)?;
            } else if role == Role::Cell {
                slots[k] = f64::NAN;
            } else if !native_basis {
                // (…against no basis at all — a pass root handed none — a percentage size is `auto`, as against any
                // indefinite one)
                if basis.is_nan() {
                    continue;
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
        // (…and a cell's min / max in its BLOCK axis are none: its row sizes it. Asked of the
        // display: a flex or grid item's is blockified and none. The block axis is
        // the WIDTH in a vertical writing mode, where a `min-height` does clamp: Chrome, 80.)
        let cell_free_x = matches!(display.inside(), DisplayInside::TableCell) && !style.writing_mode.is_horizontal();
        if matches!(display.inside(), DisplayInside::TableCell) {
            if cell_free_x {
                (rec.min_w, rec.max_w) = (f64::NAN, f64::NAN);
            } else {
                (rec.min_h, rec.max_h) = (f64::NAN, f64::NAN);
            }
        }
        // (…the DECLARED inline sizing, which has no basis at all: a percentage in it is none, `auto` — and a vertical
        // cell's min / max width none either, its block axis's, as the record's are)
        let declared = |k: usize| sizes[k].0.filter(|lp| !lp.has_percentage()).map_or(Ok(f64::NAN), |lp| length(lp));
        rec.decl_w = declared(0)?;
        rec.decl_min_w = if cell_free_x { f64::NAN } else { declared(2)? };
        rec.decl_max_w = if cell_free_x { f64::NAN } else { declared(3)? };
        rec.pct_h_decl = [1, 4, 5].iter().any(|&k| sizes[k].0.is_some_and(|lp| lp.has_percentage()))
            || (position == Position::Relative && [&pos.top, &pos.bottom].iter().any(|i| inset_lp(i).ok().flatten().is_some_and(|lp| lp.has_percentage())));
        // The margins and padding, likewise — against the containing block's WIDTH, all eight.
        let (edges, auto) = edge_lps(&style)?;
        rec.auto_margins = auto;
        let parts = if !edges.iter().flatten().any(|lp| lp.has_percentage()) {
            EdgeParts::at(&edges, 0.0)?
        } else if !edge_basis && self.basis.w.is_nan() {
            // (…and a percentage edge against no basis resolves to 0)
            EdgeParts::at(&edges, 0.0)?
        } else if !edge_basis {
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
        [rec.bt, rec.br, rec.bb, rec.bl] = self.collapse.get(&id).copied().unwrap_or_else(|| used_borders(&style));
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
        // (…the pass root's the direction it USES, the principal writing mode's: `principal_rtl`)
        let rtl = if parent < 0 { principal_rtl(self.arena, id) } else { style.get_inherited_box().direction == Direction::Rtl };
        rec.rtl = rtl as u8;
        // (…and whether its BLOCK axis is the horizontal one: a vertical writing mode, whose auto width is its content's)
        rec.block_axis_is_x = !style.writing_mode.is_horizontal();
        rec.scrolls_x = scrolls(b.overflow_x);
        rec.scrolls_y = scrolls(b.overflow_y);
        rec.clip = self.clip_flags(id, &style);
        rec.legacy_align = self.legacy_align(id);
        rec.legend_align = self.legend_align(id, &style);
        // `position: relative` is a shift applied after the flow (§9.4.3) — not the pass root's, which is folded into
        // the origin it is handed.
        if parent >= 0 && position == Position::Relative && role != Role::Cell {
            self.relative(id, &style, &mut rec)?;
        }
        self.push_record(rec);
        self.rec_index.insert(id, idx);
        if let Some(intrinsic) = intrinsic {
            return self.replaced(id, idx, &style, intrinsic);
        }
        if matches!(display.inside(), DisplayInside::Flex) && !widget_block {
            return self.flex(id, idx, &style);
        }
        if matches!(display.inside(), DisplayInside::Grid) && !widget_block {
            return self.grid(id, idx, &style, parent);
        }
        if matches!(display.inside(), DisplayInside::Table) && !widget_block {
            return self.table(id, idx, &style, role, parent);
        }
        let kids: Vec<NodeId> = self.children(id).collect();
        self.block_contents(&kids, idx, &style)
    }

    // A block container's children: block-level boxes, floats, out-of-flow boxes, or inline content.
    fn block_contents(&mut self, kids: &[NodeId], idx: i32, style: &ComputedValues) -> Step {
        // What the children are to this block's flow: block-level boxes, or inline content.
        let ws_mode = ws_mode_of(style)?;
        // (…the block-level children and the out-of-flow ones, in document order: an out-of-flow box's static position
        // is where the flow reached it.)
        let mut blocks: Vec<(NodeId, Kid)> = Vec::new();
        let mut in_flow = false;
        let mut inline = false;
        // (…and the runs of table boxes it holds with no table around them, each an anonymous table's (CSS 2.1 §17.2.1):
        // a run is CONSECUTIVE siblings, white space that collapses between them no break in it)
        let mut tables: Vec<Vec<NodeId>> = Vec::new();
        let mut open_table = false;
        for &c in kids {
            let cn = self.node(c);
            match cn.kind {
                NodeKind::Text => {
                    let child_mode = self.text_ws_mode(c, ws_mode)?;
                    if has_content(&cn.data) || white_space_only_is_content(&cn.data, child_mode) {
                        inline = true;
                        open_table = false;
                    }
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let cb = cs.get_box();
                    let cd = self.laid_display(c, cb);
                    if cd.is_none() {
                        continue;
                    }
                    if matches!(cb.clone_position(), Position::Absolute | Position::Fixed) {
                        blocks.push((c, Kid::OutOfFlow));
                        open_table = false;
                        continue;
                    }
                    if cb.clone_float() != Float::None {
                        blocks.push((c, Kid::Float));
                        open_table = false;
                        continue;
                    }
                    if matches!(cd.outside(), DisplayOutside::InternalTable | DisplayOutside::TableCaption) {
                        if open_table {
                            tables.last_mut().expect("an open run").push(c);
                            blocks.push((c, Kid::InTable));
                        } else {
                            tables.push(vec![c]);
                            blocks.push((c, Kid::Table(tables.len() - 1)));
                            open_table = true;
                        }
                        in_flow = true;
                        continue;
                    }
                    open_table = false;
                    if matches!(cd.outside(), DisplayOutside::Inline) && !(matches!(cd.inside(), DisplayInside::Flow) && self.holds_block_level(c)?) {
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
            return self.mixed_block(kids, idx, style, ws_mode, &blocks, &tables);
        }
        if inline {
            return self.text_block(kids, idx, style, ws_mode);
        }
        self.inputs[idx as usize].display = DISPLAY_BLOCK;
        self.inputs[idx as usize].ws_mode = ws_mode;
        // The cursor an out-of-flow child reads is a LINE cursor: the block's first-line indent and its line height.
        if blocks.iter().any(|&(_, kid)| kid == Kid::OutOfFlow) {
            let (indent, bits) = indent(style)?;
            let math = self.math(indent.prog.as_deref());
            let lh = self.font_info(style, style)?.lh;
            let rec = &mut self.inputs[idx as usize];
            rec.indent_px = indent.px;
            rec.indent_frac = indent.frac;
            rec.indent_math = math;
            rec.indent_hanging = bits & 256 != 0;
            rec.indent_each_line = bits & 512 != 0;
            rec.strut_lh = lh;
        }
        for (c, kid) in blocks {
            match kid {
                Kid::OutOfFlow => {
                    self.out_of_flow(c, idx)?;
                }
                Kid::Block => self.block_child(c, idx, style)?,
                Kid::Float => self.record(c, idx)?,
                Kid::Table(t) => self.anonymous_table(&tables[t], idx, style)?,
                Kid::InTable => {}
            }
        }
        Ok(())
    }

    // A block child `c` of the block container at record `parent`: spliced back from the last pass where it can be
    // (`splice`), walked otherwise — with what its walk read from outside it kept beside its record, for the next pass.
    fn block_child(&mut self, c: NodeId, parent: i32, parent_style: &ComputedValues) -> Step {
        let ctx = self.child_ctx(parent, parent_style)?;
        if self.splice(c, parent, ctx) {
            return Ok(());
        }
        let at = self.inputs.len();
        self.record(c, parent)?;
        if at < self.inputs.len() {
            self.extents[at].ctx = Some(ctx);
        }
        Ok(())
    }
    fn child_ctx(&mut self, parent: i32, parent_style: &ComputedValues) -> Result<Ctx, &'static str> {
        let root_font_size = match self.root_font_size {
            Some(v) => v,
            None => *self.root_font_size.insert(self.root_font_size()?),
        };
        let parent_node = NodeId::from_i64(self.inputs[parent as usize].nid as i64);
        Ok(Ctx {
            saw_in: self.saw_float,
            legacy_align: parent_node.map_or(0, |p| self.legacy_align(p)),
            parent_rtl: parent_style.get_inherited_box().direction == Direction::Rtl,
            basis: [self.basis.w.to_bits(), self.basis.h.to_bits()],
            root_font_size: root_font_size.to_bits(),
        })
    }

    // The block child `c` of the block container at record `parent` SPLICED back from the last kept pass instead of
    // walked, where nothing in its flat subtree has changed since that pass began (`NodeData::stamp`) and nothing its walk
    // read from outside it has either (`Ctx`): its records, runs, grid values and inline entries as they were, every
    // position moved to where they go now — its records' parents, run and grid starts and containing blocks inside it, its
    // runs' records and inline entries — the anonymous boxes and inline boxes it holds named to the JS side again, and the
    // floats its formatting context had placed when it was done. False where it cannot be, for the caller to walk it.
    // (Never in an attempt, never the `<body>`, whose formatting context reads the root's `overflow`, and never a
    // `<legend>`, which its SIBLINGS make its fieldset's rendered legend or not — a change no stamp of its own records.)
    fn splice(&mut self, c: NodeId, parent: i32, ctx: Ctx) -> bool {
        let Some(prior) = self.prior else { return false };
        let Some(node) = self.arena.get(c) else { return false };
        if self.attempts > 0 || node.stamp.get() > prior.walked || node.rendering_tag() == "body" || node.is_html_named("legend") {
            return false;
        }
        let Some(&j) = prior.by_nid.get(&c.to_f64().to_bits()) else { return false };
        let was = prior.extents[j];
        let (Some(end), Some(was_ctx)) = (was.end, was.ctx) else { return false };
        if was_ctx != ctx || !prior.spliceable[j] {
            return false;
        }
        let [end, runs_end, grids_end, inls_end] = end;
        let [runs_at, grids_at, inls_at] = was.start;
        let at = self.inputs.len();
        let d_rec = at as i32 - j as i32;
        let d_run = self.runs.len() as i32 - runs_at as i32;
        let d_grid = self.grids.len() as i32 - grids_at as i32;
        let d_inl = self.inlines.len() as i32 - inls_at as i32;
        for k in j..end {
            let mut x = prior.inputs[k];
            x.parent = if k == j { parent } else { x.parent + d_rec };
            if x.run_count > 0 {
                x.run_start += d_run;
            }
            if crate::walk_reuse::has_grid(&x) {
                x.grid_start += d_grid;
            }
            if x.cb_index >= 0 {
                x.cb_index += d_rec;
            } else if x.cb_index == crate::layout::CB_INLINE {
                x.cb_rect[0] += d_inl as f64;
            }
            let e = prior.extents[k];
            let shift3 = |p: [usize; 3]| [(p[0] as i32 + d_run) as usize, (p[1] as i32 + d_grid) as usize, (p[2] as i32 + d_inl) as usize];
            self.extents.push(Extent {
                start: shift3(e.start),
                end: e.end.map(|q| [(q[0] as i32 + d_rec) as usize, (q[1] as i32 + d_run) as usize, (q[2] as i32 + d_grid) as usize, (q[3] as i32 + d_inl) as usize]),
                ..e
            });
            self.inputs.push(x);
        }
        for u in runs_at..runs_end {
            let mut r = prior.runs[u];
            match r.kind {
                RUN_OOF | RUN_FLOAT | RUN_ATOMIC if r.font >= 0 => r.font += d_rec,
                RUN_OPEN | RUN_CLOSE | RUN_WBR => r.font += d_inl,
                RUN_BR if r.font >= 0 => r.font += d_inl,
                _ => {}
            }
            self.runs.push(r);
            self.run_texts.push(prior.run_texts[u].clone());
        }
        self.grids.extend_from_slice(&prior.grids[grids_at..grids_end]);
        self.inlines.extend_from_slice(&prior.inlines[inls_at..inls_end]);
        for l in inls_at..inls_end {
            if let Some(el) = NodeId::from_i64(prior.inline_nids[l] as i64).filter(|_| prior.inline_nids[l] >= 0.0) {
                self.inline_of.insert(el, (l as i32 + d_inl) as usize);
            }
        }
        for row in prior.anon.iter().filter(|r| (j..end).contains(&(r[0] as usize))) {
            self.anon.push([row[0] + d_rec as f64, row[1], row[2], row[3]]);
        }
        self.rec_index.insert(c, at as i32);
        self.saw_float = was.saw_out;
        self.spliced.push(Splice { at, was: j, n: end - j });
        true
    }

    // A block holding BOTH block-level boxes and inline content (§9.2.1.1): each maximal run of inline content is an
    // ANONYMOUS block of lines — a record of no element (nid −1) — among the block children in document order. Floats
    // and out-of-flow boxes join the run they are written in, as markers on its lines. A run that makes no line is
    // no box: its records are taken back, and its floats go where the next line would have started — among the
    // block's own children.
    #[allow(clippy::too_many_arguments)]
    fn mixed_block(&mut self, kids: &[NodeId], idx: i32, style: &ComputedValues, ws_mode: u8, blocks: &[(NodeId, Kid)], tables: &[Vec<NodeId>]) -> Step {
        let font = self.font_info(style, style)?;
        let (indent, bits) = indent(style)?;
        let bites = indent.px != 0.0 || indent.frac != 0.0 || indent.prog.is_some();
        let align = align_code(style.get_inherited_text().text_align, starts_at_right(style));
        let wrap = wrap_mode(style);
        self.inputs[idx as usize].display = DISPLAY_BLOCK;
        self.inputs[idx as usize].ws_mode = ws_mode;
        // (…an anonymous table among them where its run starts, and the rest of its run nowhere: it is in the table)
        let block_kids: Vec<(NodeId, Kid)> = blocks.iter().filter(|&&(_, kid)| matches!(kid, Kid::Block | Kid::Table(_) | Kid::InTable)).copied().collect();
        let mut unspent = true;
        let mut group: Vec<NodeId> = Vec::new();
        for c in kids.iter().copied().map(Some).chain(std::iter::once(None)) {
            let end = c.is_none();
            let c = c.unwrap_or(NodeId::from_i64(0).expect("a placeholder"));
            let kid = if end { None } else { block_kids.iter().find(|&&(b, _)| b == c).map(|&(_, kid)| kid) };
            if kid == Some(Kid::InTable) {
                continue;
            }
            let is_block = kid.is_some();
            if !end && !is_block {
                let n = self.node(c);
                if n.kind == NodeKind::Element && self.laid_display(c, self.style(c)?.get_box()).is_none() {
                    continue;
                }
                if matches!(n.kind, NodeKind::Text | NodeKind::Element) {
                    group.push(c);
                }
                continue;
            }
            // (…the white space between block children, the commonest run there is, is none without an attempt)
            let kids = std::mem::take(&mut group);
            let mut only_space = true;
            for &k in &kids {
                let n = self.node(k);
                if n.kind != NodeKind::Text || has_content(&n.data) || white_space_only_is_content(&n.data, self.text_ws_mode(k, ws_mode)?) {
                    only_space = false;
                    break;
                }
            }
            if !kids.is_empty() && !only_space {
                let mark = self.mark();
                let anon = self.inputs.len() as i32;
                let mut rec = fresh_record();
                rec.nid = -1.0;
                rec.parent = idx;
                rec.display = DISPLAY_TEXT_BLOCK;
                self.push_record(rec);
                let mut g = Gather { block: style, idx: anon, runs: Vec::new(), makes_line: false, floats: Vec::new(), rel: None };
                self.attempts += 1;
                let gathered = self.gather(&kids, style, &font, ws_mode, wrap, 0.0, &mut g);
                self.attempts -= 1;
                gathered?;
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
                    // (…a block with no indent writes none of it, the `spent` bit included)
                    r.indent_spent = !unspent && (bites || bits != 0);
                    unspent = false;
                    r.rtl = parent.rtl;
                    r.block_axis_is_x = parent.block_axis_is_x;
                    r.text_align = align;
                    r.anon_group = true;
                    self.commit(anon, g);
                }
            }
            match kid {
                Some(Kid::Table(t)) => {
                    unspent = false;
                    self.anonymous_table(&tables[t], idx, style)?;
                }
                Some(_) => {
                    unspent = false;
                    self.block_child(c, idx, style)?;
                }
                None => {}
            }
        }
        Ok(())
    }

    // A replaced element's or a control's INTRINSIC size (`intrinsicSize`) — None for any other: the decoded image's,
    // a frame's default object size, a canvas's or an svg's from its attributes, a control's from the UA's chrome
    // or, for a button `<input>` and a `<select>`, from the label it draws measured in its own font.
    fn intrinsic(&mut self, id: NodeId) -> Result<Option<Intrinsic>, &'static str> {
        let node = self.node(id);
        let sized = |w: f64, h: f64| Intrinsic { w, h, ratio: false, ratio_only: false };
        Ok(Some(match node.rendering_tag() {
            "iframe" | "frame" | "embed" | "video" => sized(300.0, 150.0),
            // (…the default object size, as an `<iframe>`'s — unless it shows its fallback, and is no replaced element)
            "object" if renders_object_fallback(self.arena, id, node) => return Ok(None),
            "object" => sized(300.0, 150.0),
            "canvas" => {
                let dim = |name: &str, default: f64| node.get_attr(name).and_then(crate::validity::parse_non_negative).map_or(default, |n| n as f64);
                Intrinsic { ratio: true, ..sized(dim("width", 300.0), dim("height", 150.0)) }
            }
            "img" => match node.natural_size {
                Some((w, h)) => Intrinsic { ratio: true, ..sized(w, h) },
                None => sized(16.0, 16.0),
            },
            "input" => {
                let ty = node.get_attr("type").map(|t| t.to_ascii_lowercase()).filter(|t| !t.is_empty()).unwrap_or_else(|| "text".into());
                match ty.as_str() {
                    "checkbox" | "radio" => sized(13.0, 13.0),
                    "file" => sized(253.0, 21.0),
                    "range" => sized(129.0, 16.0),
                    "color" => sized(44.0, 23.0),
                    "image" => sized(0.0, 0.0),
                    "date" => sized(118.33, 20.0),
                    "time" => sized(97.0, 20.0),
                    "datetime-local" => sized(204.33, 20.0),
                    "month" => sized(148.33, 20.0),
                    "week" => sized(140.33, 20.0),
                    "submit" | "reset" | "button" => {
                        let default = match ty.as_str() {
                            "submit" => "Submit",
                            "reset" => "Reset",
                            _ => "",
                        };
                        let label: Vec<u16> = node.plain_attr_units("value").unwrap_or_else(|| default.encode_utf16().collect());
                        self.label_size(id, &label)?
                    }
                    _ => sized(177.0, 15.0),
                }
            }
            "svg" => self.svg_intrinsic(id)?,
            "select" => {
                // (…a drop-down is its widest option and an arrow, in whole px; a LIST BOX has no arrow and no rounding,
                // and a row per displayed row)
                let widest = self.widest_option(id, id, 0.0, 0.0)?;
                if self.arena.is_list_box(id) {
                    sized(widest + 19.0, 17.0 * self.arena.select_display_size(id) as f64)
                } else {
                    sized((widest + 20.0).ceil(), 17.0)
                }
            }
            "textarea" => sized(195.0, 36.0),
            "audio" => sized(300.0, 54.0),
            "meter" => sized(80.0, 16.0),
            "progress" => sized(160.0, 16.0),
            _ => return Ok(None),
        }))
    }
    // A button `<input>`'s content box: its label, a line per line of it, measured in its font (`buttonInputSize`).
    fn label_size(&mut self, id: NodeId, label: &[u16]) -> Result<Intrinsic, &'static str> {
        let style = self.style(id)?;
        let font = self.font_info(&style, &style)?;
        let sized = |w: f64, h: f64| Intrinsic { w, h, ratio: false, ratio_only: false };
        if label.is_empty() {
            return Ok(sized(0.0, font.lh));
        }
        let lines: Vec<&[u16]> = split_label_lines(label);
        let mut width = 0.0f64;
        for line in &lines {
            width = width.max(self.measure(&font, line));
        }
        Ok(sized(width, lines.len() as f64 * font.lh))
    }
    // A run of text's advance in a font (`FontMetrics::measure_run`).
    fn measure(&self, font: &FontInfo, text: &[u16]) -> f64 {
        crate::font::with_font(font.face, |fm| fm.measure_run(text, font.size, font.ls, font.ws, 0.0, font.tab_px, font.tab_min)).unwrap_or(f64::NAN)
    }
    // The widest option of a `<select>`, an optgroup's indented 15px (`widestOptionWidth`): its `label`, else its text,
    // collapsed by the select's `white-space` and measured in the select's font.
    fn widest_option(&mut self, node: NodeId, select: NodeId, widest: f64, indent: f64) -> Result<f64, &'static str> {
        let mut widest = widest;
        for c in self.children(node).collect::<Vec<_>>() {
            let n = self.node(c);
            if n.kind != NodeKind::Element {
                continue;
            }
            if n.rendering_tag() != "option" {
                let inner = if n.rendering_tag() == "optgroup" { indent + 15.0 } else { indent };
                widest = self.widest_option(c, select, widest, inner)?;
                continue;
            }
            let label: Vec<u16> = match n.plain_attr_units("label") {
                Some(l) if !l.is_empty() => l,
                _ => {
                    let mut out = Vec::new();
                    self.collect_text(c, &mut out);
                    out
                }
            };
            let style = self.style(select)?;
            let font = self.font_info(&style, &style)?;
            let text = collapse_run(&label, ws_mode_of(&style)?);
            widest = widest.max(indent + self.measure(&font, &text));
        }
        Ok(widest)
    }
    fn collect_text(&self, node: NodeId, out: &mut Vec<u16>) {
        for c in self.children(node) {
            let n = self.node(c);
            match n.kind {
                NodeKind::Text => out.extend_from_slice(&n.data),
                NodeKind::Element => self.collect_text(c, out),
                _ => {}
            }
        }
    }
    // An `<svg>`'s intrinsic size from its `width` / `height` attributes and its `viewBox` ratio (`svgIntrinsic`).
    fn svg_intrinsic(&self, id: NodeId) -> Result<Intrinsic, &'static str> {
        let node = self.node(id);
        let em = font_size(&*self.style(id)?);
        let root = self.root_font_size()?;
        let length = |name: &str| node.get_attr(name).and_then(|v| svg_length(v, em, root));
        let vb = node.get_attr("viewBox").and_then(view_box);
        let (w, h) = (length("width"), length("height"));
        let i = |w: f64, h: f64, ratio: bool, ratio_only: bool| Intrinsic { w, h, ratio, ratio_only };
        Ok(match (w, h) {
            (Some(w), Some(h)) => i(w, h, true, false),
            (Some(w), None) => i(w, vb.map_or(150.0, |(vw, vh)| w * vh / vw), vb.is_some(), false),
            (None, Some(h)) => i(vb.map_or(300.0, |(vw, vh)| h * vw / vh), h, vb.is_some(), false),
            (None, None) => match vb {
                Some((vw, vh)) => i(vw, vh, true, true),
                None => i(300.0, 150.0, false, false),
            },
        })
    }
    // The root element's font size, which an `rem` resolves against.
    fn root_font_size(&self) -> Result<f64, &'static str> {
        let mut cur = self.root;
        while let Some(p) = self.parent_of(cur).filter(|&p| self.node(p).kind == NodeKind::Element) {
            cur = p;
        }
        Ok(font_size(&*self.style(cur)?))
    }

    // A REPLACED leaf's record: a childless block sized from its intrinsic figures, its
    // margins never adjoining, and — for a control that draws text — where its baseline sits in its font.
    fn replaced(&mut self, id: NodeId, idx: i32, style: &ComputedValues, intrinsic: Intrinsic) -> Step {
        let node = self.node(id);
        let tag = node.rendering_tag();
        let list_box = tag == "select" && self.arena.is_list_box(id);
        // A LIST BOX showing rows is the control's box with its options stacked in it as ordinary block children:
        // its box from the intrinsic data like any replaced one's, its rows laid out inside it —
        // and its baseline read off them, not off the control.
        if list_box && self.lays_out_rows(id)? {
            let r = &mut self.inputs[idx as usize];
            r.intrinsic_w = intrinsic.w;
            r.intrinsic_h = intrinsic.h;
            r.replaced = true;
            r.lays_out_children = true;
            r.form_control = true;
            r.ratio = intrinsic.ratio;
            r.ratio_only = intrinsic.ratio_only;
            let kids: Vec<NodeId> = self.children(id).collect();
            return self.block_contents(&kids, idx, style);
        }
        let draws_text = tag == "select"
            || (tag == "input"
                && !matches!(
                    node.get_attr("type").map(|t| t.to_ascii_lowercase()).as_deref(),
                    Some("checkbox" | "radio" | "range" | "image")
                ));
        let baseline = if draws_text {
            let face = self.face(style)?;
            Some((content_height(style, &face), content_ascent(style, &face)))
        } else {
            None
        };
        let r = &mut self.inputs[idx as usize];
        r.display = DISPLAY_BLOCK;
        r.height_adjoins = false;
        r.minh_adjoins = false;
        r.bottom_adjoins = false;
        r.intrinsic_w = intrinsic.w;
        r.intrinsic_h = intrinsic.h;
        r.replaced = true;
        r.ratio = intrinsic.ratio;
        r.ratio_only = intrinsic.ratio_only;
        r.shrinks_to_nothing = intrinsic.ratio || tag == "img";
        // (…the controls a percentage max-width does not squeeze, as Chrome reads CSS Sizing 3 §5.2.2: a `<meter>` and a
        // `<progress>` too)
        r.form_control = matches!(tag, "input" | "select" | "textarea" | "meter" | "progress");
        match baseline {
            Some((font_box, asc)) => {
                // (…a list box's baseline is its content box's bottom, a text control's its font box's)
                r.control_baseline = if list_box { 2 } else { 1 };
                r.control_font_box = font_box;
                r.control_font_asc = asc;
            }
            None if tag != "img" => r.control_baseline = 4,
            None => {}
        }
        self.control_text(id, idx, style)
    }

    // The text a form control SHOWS (`RealmArena::shown_text`) as its record's runs, which the layout lays out as lines in
    // its content box and its size never reads (layout.rs `control_lines`): a textarea's wrapped as its own `white-space`
    // says — the UA's `pre-wrap` — and any other control's on a line of its own, preserved, as its inner editor holds
    // it. In the control's font, or its `::placeholder`'s while that is what it shows.
    fn control_text(&mut self, id: NodeId, idx: i32, style: &ComputedValues) -> Step {
        // (…but a CUSTOMIZABLE select, `appearance: base-select`, which shows no drop-down face)
        if style.get_box().clone_appearance() == style::values::computed::Appearance::BaseSelect {
            return Ok(());
        }
        let Some((text, placeholder)) = self.arena.shown_text(id).filter(|(t, _)| !t.is_empty()) else { return Ok(()) };
        let own;
        let owner: &ComputedValues = if placeholder {
            own = self.engine.and_then(|e| e.placeholder_style(self.arena, id)).ok_or("placeholder-unstyled")?;
            &own
        } else {
            style
        };
        let font = self.font_info(owner, style)?;
        let textarea = self.node(id).rendering_tag() == "textarea";
        let ws_mode = if textarea { ws_mode_of(owner)? } else { WS_PRE };
        let vmax = self.split_vmax(owner, &font, &text, ws_mode)?;
        let owners = if self.painting { vec![(0, id.to_f64())] } else { Vec::new() };
        let run = Pending::Text { font, text, wrap: wrap_mode(owner), ws: ws_mode, shift: 0.0, vmax, owners };
        let g = Gather { block: style, idx, runs: vec![run], makes_line: true, floats: Vec::new(), rel: None };
        let strut = self.font_info(style, style)?;
        let (indent, indent_bits) = indent(style)?;
        let indent_math = self.math(indent.prog.as_deref());
        let r = &mut self.inputs[idx as usize];
        r.strut_lh = strut.lh;
        r.strut_asc = strut.asc;
        r.ws_mode = ws_mode;
        r.text_align = align_code(style.get_inherited_text().text_align, starts_at_right(style));
        r.indent_px = indent.px;
        r.indent_frac = indent.frac;
        r.indent_math = indent_math;
        r.indent_hanging = indent_bits & 256 != 0;
        r.indent_each_line = indent_bits & 512 != 0;
        r.text_overflows = textarea || !placeholder;
        self.commit(idx, g);
        if let Some(mark) = self.paint.last_mut().filter(|_| self.painting && placeholder) {
            mark.placeholder = true;
        }
        Ok(())
    }

    // Does a replaced box lay CSS boxes out inside itself: a rendered element child?
    fn lays_out_rows(&self, id: NodeId) -> Result<bool, &'static str> {
        for c in self.children(id) {
            if self.node(c).kind == NodeKind::Element && !self.laid_display(c, self.style(c)?.get_box()).is_none() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // Is the element's parent a flex or grid container?
    fn parent_is_item_container(&self, id: NodeId) -> Result<bool, &'static str> {
        let Some(p) = self.layout_parent(id).filter(|&p| self.node(p).kind == NodeKind::Element) else { return Ok(false) };
        Ok(self.laid_display(p, self.style(p)?.get_box()).is_item_container())
    }

    // Is the element an item of a flex container — its parent one, and itself in flow?
    fn flex_item(&self, id: NodeId) -> Result<bool, &'static str> {
        let Some(p) = self.layout_parent(id).filter(|&p| self.node(p).kind == NodeKind::Element) else { return Ok(false) };
        Ok(matches!(self.laid_display(p, self.style(p)?.get_box()).inside(), DisplayInside::Flex))
    }

    // A flex or grid container's items (`boxItems`), in document order with each one's `order`: every in-flow element
    // child, the out-of-flow ones apart — and each run of bare text (with any `<br>` / `<wbr>` in it) between two of
    // them an ANONYMOUS item of its own, where it holds anything but white space.
    #[allow(clippy::type_complexity)]
    fn box_items(&self, id: NodeId) -> Result<(Vec<(i32, FlexItem)>, Vec<NodeId>), &'static str> {
        let mut items: Vec<(i32, FlexItem)> = Vec::new();
        let mut oof: Vec<NodeId> = Vec::new();
        let mut run: Vec<NodeId> = Vec::new();
        let flush = |walk: &Self, run: &mut Vec<NodeId>, items: &mut Vec<(i32, FlexItem)>| {
            let kept = run.iter().any(|&k| {
                let n = walk.node(k);
                n.kind == NodeKind::Element || has_content(&n.data)
            });
            let run = std::mem::take(run);
            if kept {
                let ordinal = items.iter().filter(|(_, it)| matches!(it, FlexItem::Anonymous(..))).count() as u32;
                items.push((0, FlexItem::Anonymous(run, ordinal)));
            }
        };
        for c in self.children(id).collect::<Vec<_>>() {
            let n = self.node(c);
            match n.kind {
                NodeKind::Text => run.push(c),
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let b = cs.get_box();
                    if self.laid_display(c, b).is_none() {
                        continue;
                    }
                    if matches!(n.rendering_tag(), "br" | "wbr") {
                        run.push(c);
                        continue;
                    }
                    flush(self, &mut run, &mut items);
                    if matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
                        oof.push(c);
                    } else {
                        items.push((cs.get_position().order, FlexItem::Element(c)));
                    }
                }
                _ => {}
            }
        }
        flush(self, &mut run, &mut items);
        Ok((items, oof))
    }

    // A `subgrid` column template as the tracks it takes from the grid it is an item of (CSS Grid 2 §9): the ones it
    // spans where that grid places it, with that grid's column gap where its own is `normal`. None for any other template, and for a subgrid with no grid to join, or one whose
    // tracks repeat `auto-fill` / `auto-fit` (counted only when laid out), which lays out as `none`.
    // (…gaps: the parent sizes its tracks without the subgrid's items, and the subgrid's own padding and border are
    // not added to the margins of the items at its edges)
    fn subgrid_columns(&self, id: NodeId, style: &ComputedValues) -> Result<Option<(GridTemplate, Spec)>, &'static str> {
        use style::values::generics::grid::GenericGridTemplateComponent as Template;
        use style::values::generics::length::GenericLengthPercentageOrNormal as OrNormal;
        let pos = style.get_position();
        if !matches!(pos.grid_template_columns, Template::Subgrid(_)) {
            return Ok(None);
        }
        let Some(parent) = self.layout_parent(id) else { return Ok(None) };
        let parent_style = self.style(parent)?;
        if parent_style.get_box().display.inside() != DisplayInside::Grid {
            return Ok(None);
        }
        let (tracks, parent_gap) = match self.subgrid_columns(parent, &parent_style)? {
            Some(subgrid) => subgrid,
            None => (GridTemplate::of(&parent_style.get_position().grid_template_columns)?, gap(&parent_style.get_position().column_gap)?),
        };
        if tracks.repeat_kind != 0.0 {
            return Ok(None);
        }
        // (…placed as the layout places it: the parent's items up to this one, each by its column lines)
        let (items, _) = self.box_items(parent)?;
        let mut places = Vec::new();
        for (_, item) in &items {
            places.extend(match item {
                FlexItem::Element(c) => grid_column_placement(&*self.style(*c)?),
                FlexItem::Anonymous(..) => [0.0; 3],
            });
            if matches!(item, FlexItem::Element(c) if *c == id) {
                break;
            }
        }
        let (first, count) = crate::layout::grid_last_item_columns(&places, tracks.tracks.len());
        let mut taken = tracks.tracks[first..(first + count).min(tracks.tracks.len())].to_vec();
        let col_gap = match pos.column_gap {
            OrNormal::Normal => parent_gap,
            _ => {
                // A gap of its own that differs from the parent's moves the lines BETWEEN its tracks by half the
                // difference each way, which keeps the tracks where the parent has them: a fixed track grows by that
                // half on each side it shares with another (§9.2; Chrome's `column-gap: 4px` in a 10px grid lays two
                // 200px / 50px tracks out 203px and 53px wide). (…a gap: a track or a gap that is not a fixed length)
                let own = gap(&pos.column_gap)?;
                let fixed = |g: &Spec| g.frac == 0.0 && g.prog.is_none();
                if fixed(&own) && fixed(&parent_gap) {
                    let half = (parent_gap.px - own.px) / 2.0;
                    let last = taken.len() - 1;
                    for (i, track) in taken.iter_mut().enumerate() {
                        let sides = (i > 0) as u8 + (i < last) as u8;
                        if let Some(px) = track.fixed() {
                            track.px = Some(px + half * sides as f64);
                        }
                    }
                }
                own
            }
        };
        Ok(Some((GridTemplate { tracks: taken, repeat_start: -1.0, repeat_len: 0.0, repeat_kind: 0.0 }, col_gap)))
    }

    // A GRID container: its gaps, its column template with an auto repeat left for the layout to
    // count, its auto rows' height, each track's base and limit as the side specs the layout resolves, and each item's
    // declared column lines — then its items, each its own record, and its out-of-flow children.
    fn grid(&mut self, id: NodeId, idx: i32, style: &ComputedValues, parent: i32) -> Step {
        let pos = style.get_position();
        let (template, col_gap) = match self.subgrid_columns(id, style)? {
            Some(subgrid) => subgrid,
            None => (GridTemplate::of(&pos.grid_template_columns)?, gap(&pos.column_gap)?),
        };
        let mut row_gap = gap(&pos.row_gap)?;
        // (…the ROOT's percentage row gap resolves against a height nothing imposes on it — an indefinite one, against
        // which a percentage gap is 0: Chrome's `html { display: grid; row-gap: 10% }` spaces its rows by nothing)
        if parent < 0 && self.inputs[idx as usize].height.is_nan() {
            row_gap.frac = 0.0;
            row_gap.prog = None;
        }
        // (…a comparison gap rides beside its pair as its PROGRAM's offset in the math table, NaN for none)
        let program = |walk: &mut Self, prog: Option<&[f64]>| prog.map_or(f64::NAN, |p| walk.math(Some(p)) as f64);
        let (col_gap_math, row_gap_math) = (program(self, col_gap.prog.as_deref()), program(self, row_gap.prog.as_deref()));
        let (items, oof) = self.box_items(id)?;
        let row_h = grid_row_height(&pos.grid_auto_rows);
        let row_floor = if row_h.is_none() { grid_row_floor(&pos.grid_auto_rows) } else { None };
        let grid_start = self.grids.len() as i32;
        self.grids.extend([
            template.tracks.len() as f64,
            col_gap.px,
            col_gap.frac,
            row_gap.px,
            row_gap.frac,
            row_h.unwrap_or(f64::NAN),
            template.repeat_start,
            template.repeat_len,
            template.repeat_kind,
            col_gap_math,
            row_gap_math,
            row_floor.unwrap_or(f64::NAN),
        ]);
        for t in &template.tracks {
            let mut math = |p: &[f64]| self.math(Some(p));
            let base = t.floor.as_deref().unwrap_or(t).side(true, &mut math);
            let limit = if t.fr.is_some() { base } else { t.side(false, &mut math) };
            let is_auto = t.auto || t.floor.as_deref().is_some_and(|f| f.auto);
            self.grids.extend([base[0], base[1], limit[0], limit[1], t.fr.is_some() as u8 as f64, t.fr.unwrap_or(0.0), is_auto as u8 as f64, base[2], limit[2]]);
        }
        for (_, item) in &items {
            let [start, end, span] = match item {
                FlexItem::Element(c) => grid_column_placement(&*self.style(*c)?),
                FlexItem::Anonymous(..) => [0.0; 3],
            };
            self.grids.extend([start, end, span]);
        }
        {
            let r = &mut self.inputs[idx as usize];
            r.display = crate::layout::DISPLAY_GRID;
            r.grid_start = grid_start;
        }
        for (_, item) in &items {
            let at = self.inputs.len() as i32;
            match item {
                FlexItem::Element(c) => self.record(*c, idx)?,
                FlexItem::Anonymous(run, ordinal) => self.anonymous_item(id, idx, style, run, *ordinal)?,
            }
            // Under `grid-auto-rows`, an AUTO-height item IS the row height: the layout imposes the row on it as a definite
            // border-box height (a replaced one keeps its own, and an anonymous one is auto).
            // (…and under a row that is only a FLOOR, stretched to it where it is shorter — its height still its own —
            // where it STRETCHES across its row at all: `align-self`, else the grid's `align-items` — a gap: where an
            // unstretched item then sits in its row is not modelled)
            let (auto, stretches) = match item {
                FlexItem::Element(c) => {
                    let cs = self.style(*c)?;
                    let own = align_kw(cs.get_position().align_self.0);
                    let align = if own == Kw::Auto { align_kw(pos.align_items.0) } else { own };
                    let auto = size_lp(&cs.get_position().height).is_none() && self.intrinsic(*c)?.is_none();
                    // (…an `auto` margin in the block axis takes the room instead)
                    let m = cs.get_margin();
                    let auto_margin = m.margin_top.is_auto() || m.margin_bottom.is_auto();
                    (auto, !auto_margin && matches!(align, Kw::Normal | Kw::Stretch | Kw::Auto | Kw::Left | Kw::Right))
                }
                FlexItem::Anonymous(..) => (true, matches!(align_kw(pos.align_items.0), Kw::Normal | Kw::Stretch | Kw::Auto | Kw::Left | Kw::Right)),
            };
            let fixed = row_h.is_some_and(|h| h != 0.0);
            if auto && (fixed || (row_floor.is_some() && stretches)) {
                let r = &mut self.inputs[at as usize];
                r.row_imposed = true;
                if fixed {
                    r.item_auto_height = false;
                }
            }
        }
        for &c in &oof {
            self.out_of_flow(c, idx)?;
        }
        Ok(())
    }

    // A FLEX container: its axes as the codes the layout reads, its gaps, and its items — in
    // `order`, each its own record with what the layout sizes it from — then its out-of-flow children, placed by its
    // alignment.
    fn flex(&mut self, id: NodeId, idx: i32, style: &ComputedValues) -> Step {
        let (mut items, oof) = self.box_items(id)?;
        items.sort_by_key(|&(order, _)| order);
        self.flex_items(id, idx, style, FlexPlan::of(style), items, oof)
    }

    // A flex container's record and its items, on `plan`, in the order given.
    fn flex_items(&mut self, id: NodeId, idx: i32, style: &ComputedValues, plan: FlexPlan, items: Vec<(i32, FlexItem)>, oof: Vec<NodeId>) -> Step {
        let pos = style.get_position();
        let items_align = align_kw(pos.align_items.0);
        let cross_gap = gap(if plan.column { &pos.column_gap } else { &pos.row_gap })?;
        let main_gap = gap(if plan.column { &pos.row_gap } else { &pos.column_gap })?;
        let r = &mut self.inputs[idx as usize];
        r.display = crate::layout::DISPLAY_FLEX;
        r.flex_main_is_x = plan.main_is_x;
        r.flex_justify = plan.justify_code(pos.justify_content.primary());
        r.flex_wrap = plan.wrap != 0;
        r.flex_cross_flip = plan.wrap == 2;
        r.flex_align_content = align_content_code(pos.align_content.primary());
        r.flex_main_reverse = plan.main_reverse;
        r.flex_dir_reverse = plan.flex_reverse;
        r.flex_cross_far = plan.cross_far;
        [r.flex_cross_gap, r.flex_cross_gap_frac] = [cross_gap.px, cross_gap.frac];
        let cross_gap_math = self.math(cross_gap.prog.as_deref());
        self.inputs[idx as usize].flex_cross_gap_math = cross_gap_math;
        // (…and the main gap only between two items or more)
        if items.len() > 1 {
            let main_gap_math = self.math(main_gap.prog.as_deref());
            let r = &mut self.inputs[idx as usize];
            r.flex_main_gap = main_gap.px;
            r.flex_main_gap_frac = main_gap.frac;
            r.flex_main_gap_math = main_gap_math;
        }
        for (_, item) in items {
            let at = self.inputs.len() as i32;
            let (own_align, own_sides, basis, cross_auto, auto) = match item {
                FlexItem::Element(c) => {
                    self.record(c, idx)?;
                    let cs = self.style(c)?;
                    let (_, auto) = edge_lps(&cs)?;
                    let cpos = cs.get_position();
                    use style::values::generics::length::GenericSize as Size;
                    // (…across a ROW, a replaced item with a RATIO keeps it rather than stretching: an image, where a
                    // control takes the line's height)
                    let keeps_ratio = plan.main_is_x && self.intrinsic(c)?.is_some_and(|i| i.ratio);
                    let cross_auto = !keeps_ratio && if plan.main_is_x { matches!(cpos.height, Size::Auto) } else { matches!(cpos.width, Size::Auto) };
                    (align_kw(cpos.align_self.0), flow_sides(&cs), FlexBasisSpec::of(&cs)?, cross_auto, auto)
                }
                FlexItem::Anonymous(run, ordinal) => {
                    self.anonymous_item(id, idx, style, &run, ordinal)?;
                    (Kw::Auto, flow_sides(style), FlexBasisSpec { px: f64::NAN, frac: f64::NAN, prog: None, keyword: 0 }, true, 0)
                }
            };
            let mode = BaselineMode::of(&plan);
            let align = match plan.cross_align(items_align, own_align, own_sides, mode, true) {
                // (…a row whose main axis runs DOWN has no baseline geometry to align its items on: they sit at the start)
                Kw::Baseline | Kw::LastBaseline if mode == BaselineMode::Keep && !plan.main_is_x => Kw::FlexStart,
                align => align,
            };
            let basis_math = self.math(basis.prog.as_deref());
            let cross_auto_margin = if plan.main_is_x { auto & (4 | 8) != 0 } else { auto & (1 | 2) != 0 };
            let r = &mut self.inputs[at as usize];
            r.flex_basis_frac = basis.frac;
            r.flex_basis_cb = basis.px;
            r.flex_basis_math = basis_math;
            r.flex_basis_kw = basis.keyword;
            r.flex_stretch = align == Kw::Stretch && cross_auto && !cross_auto_margin;
            let align = if align == Kw::Stretch && plan.cross_far { Kw::FlexEnd } else { align };
            r.flex_cross_align = match align {
                Kw::Center => 1,
                Kw::FlexEnd => 2,
                Kw::Baseline => 3,
                Kw::LastBaseline => 4,
                _ => 0,
            };
            r.flex_item_auto = plan.auto_margin_bits(auto);
        }
        for c in oof {
            let cs = self.style(c)?;
            let code = match plan.cross_align(items_align, align_kw(cs.get_position().align_self.0), flow_sides(&cs), BaselineMode::Flow, false) {
                Kw::Center => 1,
                Kw::FlexEnd => 2,
                _ => 0,
            };
            let at = self.out_of_flow(c, idx)?;
            self.inputs[at as usize].flex_cross_align = code;
        }
        Ok(())
    }

    // A TABLE: its structure — its record, the
    // column declarations on the grids stream, a record per row group and row, its cells walked under their rows (an
    // anonymous one around each run of stray content), its captions and its out-of-flow children.
    fn table(&mut self, id: NodeId, idx: i32, style: &ComputedValues, role: Role, parent: i32) -> Step {
        let kids: Vec<NodeId> = self.children(id).collect();
        self.table_of(Some(id), id, &kids, idx, style, role, parent)
    }
    // An ANONYMOUS table (CSS 2.1 §17.2.1) around a run of `kids` — consecutive table boxes a block holds with no table
    // around them: a row, a row group, a cell, a column or a caption — in the block at record `parent` whose style it
    // inherits: no element, no box of its own beyond the table's (no border, no padding, an `auto` width and
    // `table-layout`), its cells and rows as a table's. Chrome makes one table of a block's consecutive orphan rows,
    // sharing their columns (three rows of 38.4, 48 and 19.2-wide pieces are one 105.6-wide table).
    fn anonymous_table(&mut self, kids: &[NodeId], parent: i32, style: &ComputedValues) -> Step {
        // (…the element it is in by the flat tree, which the record it hangs from may not be: an anonymous cell's has none)
        let container = self.layout_parent(kids[0]).ok_or("anonymous table in no element")?;
        let at = self.inputs.len() as i32;
        let mut rec = fresh_record();
        rec.nid = -1.0;
        rec.parent = parent;
        rec.run_start = -1;
        rec.flex_shrink = 1.0;
        [rec.width, rec.height, rec.min_w, rec.max_w, rec.min_h, rec.max_h] = [f64::NAN; 6];
        rec.starts_bfc = true;
        rec.rtl = (style.get_inherited_box().direction == Direction::Rtl) as u8;
        rec.block_axis_is_x = !style.writing_mode.is_horizontal();
        rec.legacy_align = self.legacy_align(container);
        self.push_record(rec);
        self.table_of(None, container, kids, at, style, Role::Flow, parent)
    }
    #[allow(clippy::too_many_arguments)]
    fn table_of(&mut self, table: Option<NodeId>, container: NodeId, kids: &[NodeId], idx: i32, style: &ComputedValues, role: Role, parent: i32) -> Step {
        use style::computed_values::border_collapse::T as BorderCollapse;
        let collapses = style.get_inherited_table().border_collapse == BorderCollapse::Collapse;
        let mut grid = self.table_grid(table, container, kids)?;
        // (…rows holding no cell at all are no columns either: an empty orphan row's anonymous table is one of no width)
        let empty = grid.col_count == 0 && grid.rows.iter().all(|r| r.cells.is_empty());
        // (…and columns over no row are a table as wide as they declare and of no height: Chrome's 50 for one orphan
        // `display: table-column; width: 50px`)
        if !empty && grid.col_count == 0 {
            return Err("table-half-empty");
        }
        if grid.rows.is_empty() && grid.captions.is_empty() && kids.iter().any(|&c| self.node(c).kind == NodeKind::Text && has_content(&self.node(c).data)) {
            return Err("table of bare text");
        }
        // A COLLAPSING table (§17.6.2) spaces nothing, and where it has a grid its border is the outer half of its rim
        // cells' collapsed borders and it keeps no padding: the cells hold the inner halves (`edgeInsets`).
        if collapses && !grid.rows.is_empty() && grid.col_count > 0 {
            let [top, right, bottom, left] = self.collapse_borders(&mut grid, style)?;
            let r = &mut self.inputs[idx as usize];
            // (…none: a percentage padding resolves to nothing either, its fraction and its program dropped with it)
            [r.pt, r.pr, r.pb, r.pl] = [0.0; 4];
            r.edge_px[4..].fill(0.0);
            r.edge_frac[4..].fill(0.0);
            r.edge_math[4..].fill(crate::layout::NO_MATH);
            [r.bt, r.br, r.bb, r.bl] = [top, right, bottom, left];
            r.decl_edges_x = left + right;
        }
        let spacing = style.get_inherited_table().border_spacing.clone();
        let parent_display = if parent >= 0 { Some(self.inputs[parent as usize].display) } else { None };
        {
            use style::computed_values::table_layout::T as TableLayout;
            let r = &mut self.inputs[idx as usize];
            r.display = crate::layout::DISPLAY_TABLE;
            [r.sp_x, r.sp_y] = if collapses { [0.0; 2] } else { [spacing.horizontal().to_f64_px(), spacing.vertical().to_f64_px()] };
            r.self_sizes = role != Role::OutOfFlow && parent_display.is_none_or(|d| d == DISPLAY_BLOCK);
            r.table_fixed = table.is_some() && style.get_table().table_layout == TableLayout::Fixed;
            r.grid_start = self.grids.len() as i32;
        }
        // The columns: each's declared width, a plain percentage apart, spread over the span it covers.
        let n = grid.col_count;
        let (mut spec, mut pct) = (vec![f64::NAN; n], vec![0.0f64; n]);
        let mut at = 0usize;
        for &col in &grid.columns {
            let span = span_attr(self.node(col).get_attr("span"), 1);
            let cs = self.style(col)?;
            let (frac, px) = match size_lp(&cs.get_position().width) {
                Some(lp) => match plain_percentage(lp) {
                    Some(f) => (Some(f), None),
                    None if !lp.has_percentage() => (None, Some(length(lp)?)),
                    None => (None, None),
                },
                None => (None, None),
            };
            for k in 0..span {
                if at + k >= n {
                    break;
                }
                match (frac, px) {
                    (Some(f), _) => pct[at + k] = pct[at + k].max(f),
                    (None, Some(px)) => spec[at + k] = if spec[at + k].is_nan() { px.max(0.0) } else { spec[at + k].max(px) },
                    _ => {}
                }
            }
            at += span;
        }
        self.grids.push(n as f64);
        for k in 0..n {
            self.grids.push(spec[k]);
            self.grids.push(pct[k]);
        }
        // The rows, grouped as their groups hold them, in render order (header, body, footer) — the anonymous cells among
        // them counted in that order, as `tableGrid` lists them.
        let mut anon_cells = 0u32;
        let mut i = 0;
        while i < grid.rows.len() {
            let Some(gi) = grid.rows[i].group else {
                self.table_row(&grid, i, idx, style, &mut anon_cells)?;
                i += 1;
                continue;
            };
            let g = grid.groups[gi].el;
            let at = self.table_part(g, idx, crate::layout::DISPLAY_TABLE_ROW_GROUP)?;
            while i < grid.rows.len() && grid.rows[i].group == Some(gi) {
                self.table_row(&grid, i, at, style, &mut anon_cells)?;
                i += 1;
            }
        }
        for g in grid.groups.iter().filter(|g| g.first < 0) {
            self.table_part(g.el, idx, crate::layout::DISPLAY_TABLE_ROW_GROUP)?;
        }
        for &cap in &grid.captions {
            let at = self.inputs.len() as i32;
            self.record_as(cap, idx, Role::Caption)?;
            use style::computed_values::caption_side::T as CaptionSide;
            let bottom = self.style(cap)?.get_inherited_table().caption_side == CaptionSide::Bottom;
            self.inputs[at as usize].caption_side = bottom as u8;
        }
        for &c in &grid.oof {
            self.out_of_flow(c, idx)?;
        }
        Ok(())
    }
    // Every collapsed border of a table (`ensureCollapseBorders`, CSS 2.1 §17.6.2): each edge of the grid is as wide as
    // the widest border meeting on it — the cells' either side, a row's, a group's, a column's, and at the rim the
    // table's own — unless one of them is `hidden`, which suppresses it; the two boxes sharing it own half each. Each
    // cell's halves go on the grid, and the table's own border — the widest outer half on each rim — comes back.
    fn collapse_borders(&self, grid: &mut TableGrid, table_style: &ComputedValues) -> Result<[f64; 4], &'static str> {
        const T: usize = 0;
        const R: usize = 1;
        const B: usize = 2;
        const L: usize = 3;
        let (n, rows) = (grid.col_count, grid.rows.len());
        // The columns run right to left in an rtl table: its physical left rim is the LAST column.
        let rtl = table_style.get_inherited_box().direction == Direction::Rtl;
        // (…an anonymous table has no border of its own: its rim is its cells')
        let tb = if grid.table.is_some() { collapse_sides(table_style) } else { [0.0; 4] };
        // Each cell's own four sides, and which cell covers each slot of the grid (a span, every slot it covers).
        let mut raw: Vec<Vec<[f64; 4]>> = Vec::with_capacity(rows);
        let mut occ: Vec<Option<(usize, usize)>> = vec![None; rows * n];
        for (r, row) in grid.rows.iter().enumerate() {
            let mut own = Vec::with_capacity(row.cells.len());
            for (k, cell) in row.cells.iter().enumerate() {
                own.push(match &cell.el {
                    CellEl::El(c) => collapse_sides(&*self.style(*c)?),
                    CellEl::Anon(_) => [0.0; 4],
                });
                for dr in 0..cell.row_span.min(rows - r) {
                    for dc in 0..cell.col_span.min(n - cell.col) {
                        occ[(r + dr) * n + cell.col + dc] = Some((r, k));
                    }
                }
            }
            raw.push(own);
        }
        // The rows' borders, their groups' (the sides at the rim on every row, the top on the first, the bottom on the
        // last), and the columns'.
        let (mut row_b, mut grp_top, mut grp_bot, mut grp_side) = (vec![[0.0; 4]; rows], vec![0.0; rows], vec![0.0; rows], vec![[0.0; 2]; rows]);
        for (r, row) in grid.rows.iter().enumerate() {
            if let Some(el) = row.el {
                row_b[r] = collapse_sides(&*self.style(el)?);
            }
        }
        for g in &grid.groups {
            if g.first < 0 {
                continue;
            }
            let sides = collapse_sides(&*self.style(g.el)?);
            for r in g.first as usize..=g.last as usize {
                grp_side[r] = [sides[L], sides[R]];
            }
            grp_top[g.first as usize] = sides[T];
            grp_bot[g.last as usize] = sides[B];
        }
        let mut col_b = vec![[0.0f64; 4]; n];
        let mut col_start: HashMap<NodeId, usize> = HashMap::new();
        let mut at = 0usize;
        for &col in &grid.columns {
            col_start.insert(col, at);
            let span = span_attr(self.node(col).get_attr("span"), 1);
            let cs = self.style(col)?;
            // (…a `<col span=N>` is N column boxes, each with the whole border; a childless `<colgroup span=N>` ONE,
            // whose sides land only at its rim)
            let group = matches!(self.laid_display(col, cs.get_box()).inside(), DisplayInside::TableColumnGroup);
            let sides = collapse_sides(&cs);
            for i in 0..span {
                if at + i >= n {
                    break;
                }
                let c = &mut col_b[at + i];
                if !group || i == if rtl { span - 1 } else { 0 } {
                    c[L] = combine(c[L], sides[L]);
                }
                if !group || i == if rtl { 0 } else { span - 1 } {
                    c[R] = combine(c[R], sides[R]);
                }
                c[T] = combine(c[T], sides[T]);
                c[B] = combine(c[B], sides[B]);
            }
            at += span;
        }
        for (cg, cols) in &grid.column_groups {
            let (Some(&first), Some(&last_col)) = (col_start.get(&cols[0]), cols.last()) else { continue };
            let last = col_start[&last_col] + span_attr(self.node(last_col).get_attr("span"), 1) - 1;
            if last >= n {
                continue;
            }
            let sides = collapse_sides(&*self.style(*cg)?);
            let (l, r) = if rtl { (last, first) } else { (first, last) };
            col_b[l][L] = combine(col_b[l][L], sides[L]);
            col_b[r][R] = combine(col_b[r][R], sides[R]);
            for c in &mut col_b[first..=last] {
                c[T] = combine(c[T], sides[T]);
                c[B] = combine(c[B], sides[B]);
            }
        }
        let col = |c: usize, side: usize| col_b.get(c).map_or(0.0, |b| b[side]);
        let row_side = |r: usize, side: usize| row_b.get(r).map_or(0.0, |b| b[side]);
        let at_slot = |r: usize, c: usize, side: usize| occ[r * n + c].map_or(0.0, |(rr, k)| raw[rr][k][side]);
        // An INTERNAL edge, one segment per cell faced across it, each collapsed on its own; an OUTER edge, one segment
        // per track it spans. The widest surviving half is the box's.
        let widest = |segments: &mut dyn Iterator<Item = f64>| segments.map(half).fold(0.0, f64::max);
        let (mut out_t, mut out_r, mut out_b, mut out_l) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut halves: Vec<Vec<[f64; 4]>> = Vec::with_capacity(rows);
        for (r, row) in grid.rows.iter().enumerate() {
            let mut out = Vec::with_capacity(row.cells.len());
            for (k, cell) in row.cells.iter().enumerate() {
                let own = raw[r][k];
                let (c0, cs, rs) = (cell.col, cell.col_span, cell.row_span);
                let (c_last, r_last) = (c0 + cs - 1, r + rs - 1);
                let spanned_rows = r..(r + rs).min(rows);
                let spanned_cols = c0..(c0 + cs).min(n);
                let at_left = if rtl { c0 + cs >= n } else { c0 == 0 };
                let at_right = if rtl { c0 == 0 } else { c0 + cs >= n };
                let (at_top, at_bottom) = (r == 0, r + rs >= rows);
                // A vertical edge: the column beyond it is one past the span on that physical side.
                let vertical = |own: f64, facing: usize, beyond: usize, cols_extra: f64| {
                    let seed = combine(own, cols_extra);
                    widest(&mut spanned_rows.clone().map(|rr| combine(seed, at_slot(rr, beyond, facing))))
                };
                let bl = if at_left {
                    let seed = combine(combine(own[L], tb[L]), col(if rtl { n - 1 } else { 0 }, L));
                    widest(&mut spanned_rows.clone().map(|rr| combine(combine(seed, row_side(rr, L)), grp_side[rr][0])))
                } else if rtl {
                    vertical(own[L], R, c_last + 1, combine(col(c_last + 1, R), col(c_last, L)))
                } else {
                    vertical(own[L], R, c0 - 1, combine(col(c0 - 1, R), col(c0, L)))
                };
                let br = if at_right {
                    let seed = combine(combine(own[R], tb[R]), col(if rtl { 0 } else { n - 1 }, R));
                    widest(&mut spanned_rows.clone().map(|rr| combine(combine(seed, row_side(rr, R)), grp_side[rr][1])))
                } else if rtl {
                    vertical(own[R], L, c0 - 1, combine(col(c0, R), col(c0 - 1, L)))
                } else {
                    vertical(own[R], L, c0 + cs, combine(col(c_last, R), col(c0 + cs, L)))
                };
                let bt = if at_top {
                    let seed = combine(combine(combine(own[T], tb[T]), row_side(r, T)), grp_top[r]);
                    widest(&mut spanned_cols.clone().map(|c| combine(seed, col(c, T))))
                } else {
                    let seed = combine(own[T], combine(combine(row_side(r - 1, B), row_side(r, T)), combine(grp_bot[r - 1], grp_top[r])));
                    widest(&mut spanned_cols.clone().map(|c| combine(seed, at_slot(r - 1, c, B))))
                };
                let bb = if at_bottom {
                    let seed = combine(combine(combine(own[B], tb[B]), row_side(r_last, B)), grp_bot[r_last]);
                    widest(&mut spanned_cols.clone().map(|c| combine(seed, col(c, B))))
                } else {
                    let below = r + rs;
                    let seed = combine(own[B], combine(combine(row_side(r_last, B), row_side(below, T)), combine(grp_bot[r_last], grp_top[below])));
                    widest(&mut spanned_cols.clone().map(|c| combine(seed, at_slot(below, c, T))))
                };
                if at_left {
                    out_l = out_l.max(bl);
                }
                if at_right {
                    out_r = out_r.max(br);
                }
                if at_top {
                    out_t = out_t.max(bt);
                }
                if at_bottom {
                    out_b = out_b.max(bb);
                }
                out.push([bt, br, bb, bl]);
            }
            halves.push(out);
        }
        for (row, out) in grid.rows.iter_mut().zip(halves) {
            for (cell, h) in row.cells.iter_mut().zip(out) {
                cell.halves = Some(h);
            }
        }
        Ok([out_t, out_r, out_b, out_l])
    }
    // A row group's or a row's record: its element, its parent, its display, whether it
    // scrolls.
    fn table_part(&mut self, el: NodeId, parent: i32, display: u8) -> Result<i32, &'static str> {
        let at = self.inputs.len() as i32;
        let style = self.style(el)?;
        let mut r = fresh_record();
        r.nid = el.to_f64();
        r.parent = parent;
        r.display = display;
        r.run_start = -1;
        r.scrolls_y = scrolls(style.get_box().overflow_y);
        self.push_record(r);
        // (…indexed as any element's record: a transformed row or group is an out-of-flow descendant's containing block)
        self.rec_index.insert(el, at);
        Ok(at)
    }
    // A row and its cells.
    fn table_row(&mut self, grid: &TableGrid, i: usize, parent: i32, table_style: &ComputedValues, anon_cells: &mut u32) -> Step {
        let row = &grid.rows[i];
        let at = match row.el {
            Some(el) => {
                let at = self.table_part(el, parent, crate::layout::DISPLAY_TABLE_ROW)?;
                let style = self.style(el)?;
                let r = &mut self.inputs[at as usize];
                r.row_pct = size_lp(&style.get_position().height).and_then(plain_percentage).unwrap_or(f64::NAN);
                r.row_height = if r.row_pct.is_nan() {
                    size_lp(&style.get_position().height).filter(|lp| !lp.has_percentage()).map_or(Ok(f64::NAN), length)?
                } else {
                    f64::NAN
                };
                at
            }
            None => {
                let at = self.inputs.len() as i32;
                let mut r = fresh_record();
                r.nid = -1.0;
                r.parent = parent;
                r.display = crate::layout::DISPLAY_TABLE_ROW;
                r.run_start = -1;
                self.push_record(r);
                at
            }
        };
        let rank = match row.group {
            Some(g) => grid.groups[g].rank,
            None => 1,
        };
        self.inputs[at as usize].row_rank = rank;
        for cell in &row.cells {
            let ci = self.inputs.len() as i32;
            let (valign, pct, pct_h_child) = match &cell.el {
                CellEl::El(c) => {
                    // (…a cell collapses by its OWN `border-collapse`, which it inherits but may declare apart)
                    use style::computed_values::border_collapse::T as BorderCollapse;
                    if let Some(halves) = cell.halves.filter(|_| self.style(*c).is_ok_and(|cs| cs.get_inherited_table().border_collapse == BorderCollapse::Collapse)) {
                        self.collapse.insert(*c, halves);
                    }
                    self.record_as(*c, at, Role::Cell)?;
                    let cs = self.style(*c)?;
                    (cell_valign(&cs), size_lp(&cs.get_position().width).and_then(plain_percentage).unwrap_or(f64::NAN), self.pct_height_child(*c)?)
                }
                CellEl::Anon(run) => {
                    self.anonymous_cell(grid.table, grid.container, at, table_style, run, cell.halves, *anon_cells)?;
                    *anon_cells += 1;
                    let mut any = false;
                    for &k in run {
                        any |= self.pct_height_in(k)?;
                    }
                    (0, f64::NAN, any)
                }
            };
            let r = &mut self.inputs[ci as usize];
            r.cell_valign = valign;
            r.cell_pct = pct;
            r.height_is_floor = true;
            r.cell_pct_h_child = pct_h_child;
            r.cell_col = cell.col;
            r.cell_colspan = cell.col_span;
            r.cell_rowspan = cell.row_span;
        }
        Ok(())
    }
    // An ANONYMOUS cell around a run of a row's stray content (`anonTableCell`): no element, the TABLE's inherited
    // style, and the run as its children.
    // (…in a collapsing table it is a collapse cell with no borders of its own, holding the halves the grid gave it)
    // (…named to the JS side by its table and ordinal, where it has a table element: one in an ANONYMOUS table is a box the
    // JS side has no object for, and needs none — it paints nothing of its own)
    #[allow(clippy::too_many_arguments)]
    fn anonymous_cell(&mut self, table: Option<NodeId>, container: NodeId, parent: i32, style: &ComputedValues, run: &[NodeId], halves: Option<[f64; 4]>, ordinal: u32) -> Step {
        let at = self.inputs.len() as i32;
        if let Some(table) = table {
            self.anon.push([at as f64, 1.0, table.to_f64(), ordinal as f64]);
        }
        let mut rec = fresh_record();
        rec.nid = -1.0;
        rec.parent = parent;
        rec.run_start = -1;
        rec.flex_shrink = 1.0;
        [rec.width, rec.height, rec.min_w, rec.max_w, rec.min_h, rec.max_h] = [f64::NAN; 6];
        rec.height_adjoins = true;
        rec.minh_adjoins = true;
        rec.bottom_adjoins = true;
        rec.starts_bfc = true;
        rec.rtl = (style.get_inherited_box().direction == Direction::Rtl) as u8;
        rec.block_axis_is_x = !style.writing_mode.is_horizontal();
        rec.legacy_align = self.legacy_align(container);
        if let Some(halves) = halves {
            [rec.bt, rec.br, rec.bb, rec.bl] = halves;
            rec.decl_edges_x = rec.bl + rec.br;
        }
        self.push_record(rec);
        self.block_contents(run, at, style)
    }
    // Does a cell hold a box whose height is a percentage — what makes a table lay it out twice:
    // down its in-flow boxes, past none with a definite height of its own or a table.
    fn pct_height_child(&self, cell: NodeId) -> Result<bool, &'static str> {
        for c in self.children(cell) {
            if self.pct_height_in(c)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn pct_height_in(&self, c: NodeId) -> Result<bool, &'static str> {
        if self.node(c).kind != NodeKind::Element {
            return Ok(false);
        }
        let cs = self.style(c)?;
        let b = cs.get_box();
        if self.laid_display(c, b).is_none() || matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
            return Ok(false);
        }
        let pos = cs.get_position();
        if [size_lp(&pos.height), size_lp(&pos.min_height), max_size_lp(&pos.max_height)].iter().flatten().any(|lp| lp.has_percentage()) {
            return Ok(true);
        }
        if size_lp(&pos.height).is_some() || matches!(self.laid_display(c, b).inside(), DisplayInside::Table) {
            return Ok(false);
        }
        self.pct_height_child(c)
    }
    // A table's structure (`tableGrid` / `placeCells`).
    fn table_grid(&self, table: Option<NodeId>, container: NodeId, kids: &[NodeId]) -> Result<TableGrid, &'static str> {
        let mut grid = TableGrid { table, container, rows: Vec::new(), groups: Vec::new(), captions: Vec::new(), columns: Vec::new(), column_groups: Vec::new(), oof: Vec::new(), col_count: 0 };
        self.collect_table(kids, None, &mut grid)?;
        // Each row's content as cells: a run of anything but a cell is an anonymous one.
        for row in &mut grid.rows {
            let mut cells = Vec::new();
            let mut run: Vec<NodeId> = Vec::new();
            for &n in &row.nodes {
                let is_cell = self.node(n).kind == NodeKind::Element && matches!(self.laid_display(n, self.style(n)?.get_box()).inside(), DisplayInside::TableCell);
                if is_cell {
                    if !run.is_empty() {
                        cells.push(CellEl::Anon(std::mem::take(&mut run)));
                    }
                    cells.push(CellEl::El(n));
                } else {
                    run.push(n);
                }
            }
            if !run.is_empty() {
                cells.push(CellEl::Anon(run));
            }
            row.pending = cells;
        }
        // Render order: header groups, then bodies (and rows of no group), then footers.
        let ranks: Vec<u8> = grid.rows.iter().map(|r| r.group.map_or(1, |g| grid.groups[g].rank)).collect();
        let mut order: Vec<usize> = (0..grid.rows.len()).collect();
        order.sort_by_key(|&i| ranks[i]);
        let mut rows: Vec<GridRow> = Vec::with_capacity(grid.rows.len());
        let mut taken: Vec<Option<GridRow>> = std::mem::take(&mut grid.rows).into_iter().map(Some).collect();
        for i in order {
            rows.push(taken[i].take().unwrap());
        }
        grid.rows = rows;
        for (gi, g) in grid.groups.iter_mut().enumerate() {
            g.first = grid.rows.iter().position(|r| r.group == Some(gi)).map_or(-1, |p| p as i32);
            g.last = grid.rows.iter().rposition(|r| r.group == Some(gi)).map_or(-1, |p| p as i32);
        }
        let mut col_defs = 0usize;
        for &col in &grid.columns {
            col_defs += span_attr(self.node(col).get_attr("span"), 1);
        }
        let spanned = self.place_cells(&mut grid, usize::MAX);
        // The columns the cells make — those a cell of one column starts in, under the AUTO layout, where Chrome and
        // Firefox drop a column only a span reaches; every slot a cell covers under the FIXED one, which keeps them
        // (Chrome and Firefox: `<td colspan=3>` under a one-cell row of a fixed 300px table is three columns of 100).
        let fixed = table.is_some_and(|t| {
            use style::computed_values::table_layout::T as TableLayout;
            self.style(t).is_ok_and(|s| s.get_table().table_layout == TableLayout::Fixed && !s.get_position().width.is_auto())
        });
        let mut count = col_defs;
        for row in &grid.rows {
            for cell in &row.cells {
                let reach = if fixed { cell.col + cell.col_span } else if cell.col_span == 1 { cell.col + 1 } else { 0 };
                count = count.max(reach);
            }
        }
        grid.col_count = count.max(if grid.rows.iter().any(|r| !r.cells.is_empty()) { 1 } else { 0 });
        // …and a spanning cell clamped to those columns, placed again: one that STARTS past them — pushed there by a row
        // span above it — makes a column of its own (Chrome: `<td rowspan=2>` over a `<td colspan=2>` is two columns,
        // the span clamped to the one it starts in), which may move what follows it, so until no cell starts past them.
        if spanned {
            loop {
                let n = grid.col_count;
                self.place_cells(&mut grid, n);
                let past = grid.rows.iter().flat_map(|r| &r.cells).map(|c| c.col + 1).max().unwrap_or(0);
                if past <= n {
                    break;
                }
                grid.col_count = past;
            }
        }
        Ok(grid)
    }
    fn collect_table(&self, kids: &[NodeId], group: Option<usize>, grid: &mut TableGrid) -> Step {
        let mut anon: Option<usize> = None;
        for &c in kids {
            let n = self.node(c);
            match n.kind {
                NodeKind::Text => {
                    if js_trim_empty(&n.data) {
                        continue;
                    }
                    let at = *anon.get_or_insert_with(|| {
                        grid.rows.push(GridRow { el: None, group, nodes: Vec::new(), pending: Vec::new(), cells: Vec::new() });
                        grid.rows.len() - 1
                    });
                    grid.rows[at].nodes.push(c);
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let b = cs.get_box();
                    let d = self.laid_display(c, b);
                    if d.is_none() {
                        continue;
                    }
                    if matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
                        grid.oof.push(c);
                        continue;
                    }
                    match (d.outside(), d.inside()) {
                        (DisplayOutside::InternalTable, DisplayInside::TableRow) => {
                            anon = None;
                            let nodes = self.row_content(c, grid)?;
                            grid.rows.push(GridRow { el: Some(c), group, nodes, pending: Vec::new(), cells: Vec::new() });
                        }
                        // (…a row GROUP, a caption or a column belongs to a table: inside a row group it is content
                        // like any other, which an anonymous row and cell take — and the cell an anonymous table
                        // around it, CSS 2.1 §17.2.1 (Chrome: a group nested in a group is a table in a cell))
                        (DisplayOutside::InternalTable, inside @ (DisplayInside::TableRowGroup | DisplayInside::TableHeaderGroup | DisplayInside::TableFooterGroup))
                            if group.is_none() =>
                        {
                            anon = None;
                            let rank = match inside {
                                DisplayInside::TableHeaderGroup => 0,
                                DisplayInside::TableFooterGroup => 2,
                                _ => 1,
                            };
                            grid.groups.push(GridGroup { el: c, index: grid.groups.len(), first: -1, last: -1, rank });
                            let gi = grid.groups.len() - 1;
                            let rows: Vec<NodeId> = self.children(c).collect();
                            self.collect_table(&rows, Some(gi), grid)?;
                        }
                        (DisplayOutside::TableCaption, _) if group.is_none() => {
                            anon = None;
                            grid.captions.push(c);
                        }
                        (DisplayOutside::InternalTable, DisplayInside::TableColumn) if group.is_none() => {
                            anon = None;
                            grid.columns.push(c);
                        }
                        (DisplayOutside::InternalTable, DisplayInside::TableColumnGroup) if group.is_none() => {
                            anon = None;
                            let cols: Vec<NodeId> = self
                                .children(c)
                                .filter(|&k| {
                                    self.node(k).kind == NodeKind::Element
                                        && self.style(k).is_ok_and(|ks| matches!(self.laid_display(k, ks.get_box()).inside(), DisplayInside::TableColumn))
                                })
                                .collect();
                            if cols.is_empty() {
                                grid.columns.push(c);
                            } else {
                                grid.columns.extend(cols.iter().copied());
                                grid.column_groups.push((c, cols));
                            }
                        }
                        _ => {
                            let at = *anon.get_or_insert_with(|| {
                                grid.rows.push(GridRow { el: None, group, nodes: Vec::new(), pending: Vec::new(), cells: Vec::new() });
                                grid.rows.len() - 1
                            });
                            grid.rows[at].nodes.push(c);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    // A row's content (`rowContent`): its non-blank text and its elements, an out-of-flow one set apart.
    fn row_content(&self, row: NodeId, grid: &mut TableGrid) -> Result<Vec<NodeId>, &'static str> {
        let mut out = Vec::new();
        for c in self.children(row).collect::<Vec<_>>() {
            let n = self.node(c);
            match n.kind {
                NodeKind::Text => {
                    if !js_trim_empty(&n.data) {
                        out.push(c);
                    }
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let b = cs.get_box();
                    let d = self.laid_display(c, b);
                    if d.is_none() {
                        continue;
                    }
                    if matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
                        grid.oof.push(c);
                        continue;
                    }
                    out.push(c);
                }
                _ => {}
            }
        }
        Ok(out)
    }
    // Each row's cells placed in the grid (`placeCells`): a column past those rows above still take, a `colspan` capped
    // at `limit`, a `rowspan` at its group's last row (`rowspan=0` fills it). Whether any spans.
    fn place_cells(&self, grid: &mut TableGrid, limit: usize) -> bool {
        let mut taken: Vec<std::collections::HashSet<usize>> = vec![Default::default(); grid.rows.len()];
        let mut spanned = false;
        let n_rows = grid.rows.len();
        for r in 0..n_rows {
            let pending = std::mem::take(&mut grid.rows[r].pending);
            let group_last = grid.rows[r].group.map(|g| grid.groups[g].last).filter(|&l| l >= 0);
            let last_row = group_last.map_or(n_rows as i32 - 1, |l| l);
            let mut cells = Vec::new();
            let mut c = 0usize;
            for cell in &pending {
                while taken[r].contains(&c) {
                    c += 1;
                }
                let spans = matches!(cell, CellEl::El(e) if matches!(self.node(*e).rendering_tag(), "td" | "th"));
                let attr = |name: &str| match cell {
                    CellEl::El(e) => self.node(*e).get_attr(name).map(str::to_owned),
                    CellEl::Anon(_) => None,
                };
                let col_span = if spans { span_attr(attr("colspan").as_deref(), 1).min(limit.saturating_sub(c)).max(1) } else { 1 };
                let room = ((last_row - r as i32 + 1).max(1)) as usize;
                let declared = if spans { span_attr(attr("rowspan").as_deref(), 0) } else { 1 };
                let row_span = if declared == 0 { room } else { declared.min(room) };
                if col_span > 1 || row_span > 1 {
                    spanned = true;
                }
                cells.push(GridCell { el: cell.clone(), col: c, col_span, row_span, halves: None });
                for dr in 0..row_span {
                    if r + dr < n_rows {
                        for dc in 0..col_span {
                            taken[r + dr].insert(c + dc);
                        }
                    }
                }
                c += col_span;
            }
            grid.rows[r].pending = pending;
            grid.rows[r].cells = cells;
        }
        spanned
    }

    // An ANONYMOUS flex item (`anonBoxItem`): a block of no element around a run of the container's bare text, which
    // takes the container's inherited style and every other property's initial value — its record (nid −1), and its
    // lines.
    fn anonymous_item(&mut self, container: NodeId, parent: i32, style: &ComputedValues, run: &[NodeId], ordinal: u32) -> Step {
        let at = self.inputs.len() as i32;
        self.anon.push([at as f64, 2.0, container.to_f64(), ordinal as f64]);
        let mut rec = fresh_record();
        rec.nid = -1.0;
        rec.parent = parent;
        rec.run_start = -1;
        rec.flex_shrink = 1.0;
        [rec.width, rec.height, rec.min_w, rec.max_w, rec.min_h, rec.max_h] = [f64::NAN; 6];
        rec.height_adjoins = true;
        rec.minh_adjoins = true;
        rec.bottom_adjoins = true;
        rec.starts_bfc = true;
        rec.rtl = (style.get_inherited_box().direction == Direction::Rtl) as u8;
        rec.block_axis_is_x = !style.writing_mode.is_horizontal();
        rec.legacy_align = self.legacy_align(container);
        self.push_record(rec);
        let ws_mode = ws_mode_of(style)?;
        let mut inline = false;
        for &k in run {
            let n = self.node(k);
            if n.kind == NodeKind::Element || has_content(&n.data) || white_space_only_is_content(&n.data, self.text_ws_mode(k, ws_mode)?) {
                inline = true;
                break;
            }
        }
        if !inline {
            let r = &mut self.inputs[at as usize];
            r.display = DISPLAY_BLOCK;
            r.ws_mode = ws_mode;
            return Ok(());
        }
        self.text_block(run, at, style, ws_mode)
    }

    // Where the streams stand, to take an attempt back to.
    fn mark(&self) -> Mark {
        Mark {
            inputs: self.inputs.len(),
            anon: self.anon.len(),
            runs: self.runs.len(),
            entries: self.entries.len(),
            inlines: self.inlines.len(),
            maths: self.maths.len(),
            math_index: self.math_index.len(),
            saw_float: self.saw_float,
        }
    }
    // …every stream, and the float state the attempt's floats marked: a float walked again sees only
    // the floats before it.
    fn rollback(&mut self, m: Mark) {
        self.inputs.truncate(m.inputs);
        self.extents.truncate(m.inputs);
        self.anon.truncate(m.anon);
        self.runs.truncate(m.runs);
        self.run_texts.truncate(m.runs);
        while self.paint.last().is_some_and(|p| p.run >= m.runs) {
            self.paint.pop();
        }
        self.entries.truncate(m.entries);
        self.entry_el.truncate(m.entries);
        self.inlines.truncate(m.inlines);
        let inlines = m.inlines;
        self.inline_of.retain(|_, &mut at| at < inlines);
        let inputs = m.inputs as i32;
        self.inline_cbs.retain(|&(at, _)| at < inputs);
        self.rec_index.retain(|_, &mut at| (at as usize) < m.inputs);
        if self.math_index.len() != m.math_index {
            self.maths.truncate(m.maths);
            let maths = m.maths as u32;
            self.math_index.retain(|_, &mut at| at < maths);
        }
        self.saw_float = m.saw_float;
    }

    // Each out-of-flow box whose containing block is an inline box, named by that box's entry in the inline table —
    // one the pass tabled, or the box is declined (`containingBlockBox`): its containing block is no box of this pass.
    fn resolve_inline_cbs(&mut self) -> Step {
        for &(at, cb) in &self.inline_cbs {
            let entry = *self.inline_of.get(&cb).ok_or("containingBlockBox")?;
            self.inputs[at as usize].cb_rect[0] = entry as f64;
        }
        Ok(())
    }

    // An OUT-OF-FLOW child of the container at record `parent`: its own record subtree, marked out of
    // flow and naming its CONTAINING BLOCK — a record of this pass by index, else the viewport's rectangle — with its
    // insets for the layout to resolve against that block's padding box. Its record index.
    fn out_of_flow(&mut self, id: NodeId, parent: i32) -> Result<i32, &'static str> {
        let style = self.style(id)?;
        let fixed = style.get_box().clone_position() == Position::Fixed;
        let cb = self.containing_block(id, fixed)?;
        let at = self.inputs.len() as i32;
        self.record_as(id, parent, Role::OutOfFlow)?;
        let mut insets = [(f64::NAN, 0.0, crate::layout::NO_MATH); 4];
        let pos = style.get_position();
        for (k, inset) in [&pos.top, &pos.right, &pos.bottom, &pos.left].into_iter().enumerate() {
            if let Some(lp) = inset_lp(inset)? {
                let s = spec(lp)?;
                insets[k] = (s.px, s.frac, self.math(s.prog.as_deref()));
            }
        }
        let r = &mut self.inputs[at as usize];
        r.out_of_flow = if fixed { crate::layout::OOF_FIXED } else { 1 };
        r.item_auto_height = false;
        match cb {
            Some(cb) => match self.rec_index.get(&cb) {
                Some(&at) => r.cb_index = at,
                // (…its entry once the lines holding it are committed: `resolve_inline_cbs`)
                None => {
                    r.cb_index = crate::layout::CB_INLINE;
                    self.inline_cbs.push((at, cb));
                }
            },
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

    // The element an out-of-flow box's insets measure against: the nearest positioned
    // ancestor — a fixed one's only where a transform, a filter or containment makes one its containing block — the
    // root element never; None for the viewport. One outside this pass's records is declined.
    fn containing_block(&self, id: NodeId, fixed: bool) -> Result<Option<NodeId>, &'static str> {
        let mut cur = self.parent_of(id);
        while let Some(p) = cur {
            let node = self.node(p);
            if node.kind != NodeKind::Element {
                break;
            }
            let is_root = self.parent_of(p).and_then(|d| self.get(d)).is_some_and(|d| d.kind == NodeKind::Document);
            if is_root {
                break;
            }
            let ps = self.style(p)?;
            let pd = self.laid_display(p, ps.get_box());
            let inline_flow = matches!(pd.outside(), DisplayOutside::Inline) && matches!(pd.inside(), DisplayInside::Flow);
            let block = inline_flow && self.holds_block_level(p)?;
            if !pd.is_none() && !pd.is_contents() && ((!fixed && ps.get_box().clone_position() != Position::Static) || contains_out_of_flow(&ps, self.arena, p, node)) {
                // (…an inline box is no record: the layout lays its fragments out, and names it by its inline table entry)
                let inline = inline_flow && !block;
                return if inline || self.rec_index.contains_key(&p) { Ok(Some(p)) } else { Err("containingBlockBox") };
            }
            cur = self.parent_of(p);
        }
        Ok(None)
    }

    // A relative box's offset, or — where a percentage is in an inset — the pairs and programs the layout resolves
    // against the containing block: `left`, else `right` negated (both set, the containing block's direction drops one),
    // and `top` beside `bottom`, which the layout chooses between once it knows whether the height is definite.
    fn relative(&mut self, id: NodeId, style: &ComputedValues, rec: &mut Input) -> Step {
        let pos = style.get_position();
        let [top, right, bottom, left] = [inset_lp(&pos.top)?, inset_lp(&pos.right)?, inset_lp(&pos.bottom)?, inset_lp(&pos.left)?];
        // (…the CONTAINING BLOCK's direction drops one of an over-constrained pair, §9.4.3)
        let rtl = self.flow_relative_rtl(id)?;
        let keep_right = right.is_some() && (left.is_none() || rtl);
        if ![top, right, bottom, left].iter().flatten().any(|lp| lp.has_percentage()) {
            let px = |lp: Option<&LengthPercentage>| lp.map_or(Ok(0.0), length);
            rec.rel_x = if keep_right { -px(right)? } else { px(left)? };
            rec.rel_y = if top.is_some() { px(top)? } else { -px(bottom)? };
            // (…which the record also carries in `rel_pct[5..6]`, as the base the pairs resolve onto)
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

    // A block of inline content — text and inline boxes — laid out in lines.
    fn text_block(&mut self, kids: &[NodeId], idx: i32, style: &ComputedValues, ws_mode: u8) -> Step {
        let (indent, indent_bits) = indent(style)?;
        let indent_math = self.math(indent.prog.as_deref());
        let font = self.font_info(style, style)?;
        let align = align_code(style.get_inherited_text().text_align, starts_at_right(style));
        let mut g = Gather { block: style, idx, runs: Vec::new(), makes_line: false, floats: Vec::new(), rel: None };
        self.gather(kids, style, &font, ws_mode, wrap_mode(style), 0.0, &mut g)?;
        // (…the indent and the alignment written before the gather: a block whose content makes no line keeps them
        // too.)
        let rec = &mut self.inputs[idx as usize];
        rec.indent_px = indent.px;
        rec.indent_frac = indent.frac;
        rec.indent_math = indent_math;
        rec.indent_hanging = indent_bits & 256 != 0;
        rec.indent_each_line = indent_bits & 512 != 0;
        rec.text_align = align;
        rec.ws_mode = ws_mode;
        // Only white space: an empty block — unless an inline box or a `<wbr>` occupies a line, where a first-line
        // indent is taken.
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

    // A block of lines' runs onto the streams, its inline boxes tabled in the order its runs open them, and onto its
    // record.
    fn commit(&mut self, idx: i32, g: Gather) {
        let rec = &mut self.inputs[idx as usize];
        rec.run_start = self.runs.len() as i32;
        rec.run_count = g.runs.len() as i32;
        let mut table: Vec<Option<usize>> = Vec::new();
        for r in g.runs {
            let run = match r {
                Pending::Text { font, text, wrap, ws, shift, vmax, owners } => {
                    if self.painting {
                        self.paint.push(PaintMark { run: self.runs.len(), shift, owners, placeholder: false });
                    }
                    self.run_texts.push(Some(text.into()));
                    // The run's place on its line: its ascent, `vertical-align` included, and its line-height below
                    // that — each raised to the deepest a split's faces need, so the line never shrinks.
                    let asc = font.asc + shift;
                    let (asc, line_height) = match vmax {
                        Some((va, vd)) => (asc.max(va), asc.max(va) + (font.lh - asc).max(vd)),
                        None => (asc, font.lh),
                    };
                    Run {
                        kind: RUN_TEXT,
                        font: font.face,
                        size: font.size,
                        ls: font.ls,
                        ws: font.ws,
                        line_height,
                        asc,
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
                // (…moving with the relative inline boxes around it: its static position is a reading of their content)
                Pending::Oof { ws, rec, rel } => {
                    self.run_texts.push(None);
                    let rel = rel.unwrap_or_default();
                    let prog = |walk: &mut Self, m: &Option<Vec<f64>>| match m {
                        Some(m) => walk.math(Some(m)) as f64,
                        None => f64::NAN,
                    };
                    let (xm, ym) = (prog(self, &rel.xm), prog(self, &rel.ym));
                    Run {
                        size: rel.x,
                        ls: rel.y,
                        line_height: rel.yi,
                        metric: rel.xf,
                        asc: rel.yf,
                        tab_px: xm,
                        tab_min: ym,
                        ..edge_run(RUN_OOF, rec as usize, 0.0, ws)
                    }
                }
                Pending::Float { ws, rec } => {
                    self.run_texts.push(None);
                    edge_run(RUN_FLOAT, rec as usize, 0.0, ws)
                }
                Pending::Atomic { ws, rec, shift, code, figure, line_mode } => {
                    self.run_texts.push(None);
                    Run { asc: shift, line_height: code as f64, metric: figure, line_mode, ..edge_run(RUN_ATOMIC, rec as usize, 0.0, ws) }
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
            self.inline_of.insert(self.entry_el[entry], self.inlines.len() - 1);
            self.inlines.len() - 1
        })
    }

    // The runs of `parent`'s children in the inline formatting context `g` builds: `owner` the
    // element whose font, `white-space` and wrap mode its text takes — the block, or the inline box it is in.
    fn gather(&mut self, kids: &[NodeId], owner: &ComputedValues, font: &FontInfo, ws_mode: u8, wrap: u8, shift: f64, g: &mut Gather) -> Step {
        for &c in kids {
            let cn = self.node(c);
            match cn.kind {
                NodeKind::Text => {
                    // (…a run spliced out of a box-less element still draws with THAT element's font, collapses by its
                    // `white-space` and wraps by its rules — the inherited properties it hands its content, and only
                    // those. Its `vertical-align` is none, so the shift stays the box's.)
                    let spliced = match self.parent_of(c).filter(|&p| self.boxless(p)) {
                        Some(p) => Some(self.style(p)?),
                        None => None,
                    };
                    let spliced_font = match &spliced {
                        Some(ps) => Some(self.font_info(ps, g.block)?),
                        None => None,
                    };
                    let (owner, font, ws_mode, wrap) = match (&spliced, &spliced_font) {
                        (Some(ps), Some(pf)) => (&**ps, pf, ws_mode_of(ps)?, wrap_mode(ps)),
                        _ => (owner, font, ws_mode, wrap),
                    };
                    let preserve = preserving(ws_mode);
                    let no_shy = owner.get_inherited_text().hyphens == Hyphens::None;
                    let owner_wraps = ws_mode != WS_NOWRAP && ws_mode != WS_PRE;
                    // (…a preserved CR / FF is text that is not there, and a soft hyphen under `hyphens: none` no
                    // opportunity at all)
                    use std::borrow::Cow;
                    let raw: &[u16] = &cn.data;
                    let stripped: Cow<[u16]> = if preserve && raw.iter().any(|&u| u == 0x0D || u == 0x0C) {
                        Cow::Owned(raw.iter().copied().filter(|&u| u != 0x0D && u != 0x0C).collect())
                    } else {
                        Cow::Borrowed(raw)
                    };
                    // (…but a node of NOTHING but soft hyphens keeps them: a zero-wide word that still makes its line — Chrome:
                    // `<div style="hyphens: none">&shy;</div>` is 22 tall — where one to break at is none of its business.
                    // A preserved node of nothing but CR / FF is nothing: what a text indent would make of it — 20 wide at
                    // max-content in Chrome under `text-indent: 20px` — goes unmeasured.)
                    let td: Cow<[u16]> = if no_shy && stripped.contains(&0xAD) && stripped.iter().any(|&u| u != 0xAD) {
                        Cow::Owned(stripped.iter().copied().filter(|&u| u != 0xAD).collect())
                    } else {
                        stripped.clone()
                    };
                    if td.is_empty() {
                        continue;
                    }
                    if has_content(&td) || white_space_only_is_content(&td, ws_mode) {
                        g.makes_line = true;
                    }
                    // Adjacent text is one run where it is the same font, shift, wrap and mode, the mode soft-wraps, the
                    // join does not GLUE a word, and neither side of a `pre-line` join is white space alone.
                    // (…written in the element it is a child of in the flat tree: a box-less one's, where it was spliced
                    // through one, a generated box's for its text)
                    // (…asked only of a pass a painter records: no other reads it)
                    let written_in = if self.painting { self.parent_of(c).map_or(-1.0, |p| p.to_f64()) } else { -1.0 };
                    let vmax = self.split_vmax(owner, font, raw, ws_mode)?;
                    if let Some(Pending::Text { font: lf, text, wrap: lw, ws: lws, shift: ls, vmax: lv, owners }) = g.runs.last_mut() {
                        let joinable = *lw == wrap
                            && *ls == shift
                            && *lv == vmax
                            && *lws == ws_mode
                            && owner_wraps
                            && same_font(lf, font)
                            && (is_css_ws(*text.last().unwrap()) || is_css_ws(td[0]))
                            && !(ws_mode == WS_PRE_LINE && has_content(text) != has_content(&td));
                        if joinable {
                            if self.painting && owners.last().is_none_or(|&(_, o)| o != written_in) {
                                owners.push((text.len() as u32, written_in));
                            }
                            text.extend_from_slice(&td);
                            continue;
                        }
                    }
                    g.runs.push(Pending::Text { font: *font, text: td.into_owned(), wrap, ws: ws_mode, shift, vmax, owners: if self.painting { vec![(0, written_in)] } else { Vec::new() } });
                }
                NodeKind::Element => {
                    let cs = self.style(c)?;
                    let b = cs.get_box();
                    let d = self.laid_display(c, b);
                    if d.is_none() {
                        continue;
                    }
                    if matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
                        let rec = self.out_of_flow(c, g.idx)?;
                        g.runs.push(Pending::Oof { ws: ws_mode, rec, rel: g.rel.clone() });
                        continue;
                    }
                    if b.clone_float() != Float::None {
                        let rec = self.inputs.len() as i32;
                        self.record(c, g.idx)?;
                        self.add_chain_rel(rec, g.rel.as_ref());
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
        let tag = node.rendering_tag();
        // (…an `<svg>` in HTML is a replaced element here, the SVG inside it its own business; any other element is the
        // box its style makes it — `rendering_tag` — MathML's included: its `display: math` is no value the style engine
        // has, so a MathML element is the inline its style makes it, a `display=block` `<math>` a block (ua.css), as
        // MathML Core's math boxes are on the line or a line of their own)
        let d = self.laid_display(c, cs.get_box());
        // (…a `<br>` or a `<wbr>` a flex or grid container's run of bare text holds is still a line break, or a place for
        // one, in the anonymous item, though the style engine blockifies it as the container's child)
        let blockified_break = matches!(tag, "br" | "wbr") && self.parent_is_item_container(c)?;
        if !matches!(d.outside(), DisplayOutside::Inline) && !blockified_break {
            return Err("block-level-box-in-inline-content");
        }
        // An ATOMIC inline — an `inline-block` — is one box on the line: its own record subtree under the block of
        // lines, laid out and hung from its baseline by the layout; an inline-LEVEL `<br>` still breaks the
        // line whatever its inside display (`isLineBreak`).
        if (!matches!(d.inside(), DisplayInside::Flow) && tag != "br") || replaced_or_control(self.arena, c, node) {
            // (…`top` / `bottom` hang it from the LINE, with no ascent of its own; the others move its ascent: a SHIFT
            // by itself, an alignment against the parent's font by the figure the layout reads when the box is laid out)
            let va = self.vertical_align(c, cs)?;
            let line_mode = match va {
                Some(Va { mode: VaMode::Top, .. }) => 1,
                Some(Va { mode: VaMode::Bottom, .. }) => 2,
                _ => 0,
            };
            let code = match va {
                Some(Va { mode: VaMode::Middle, .. }) => 1,
                Some(Va { mode: VaMode::TextTop, .. }) => 2,
                Some(Va { mode: VaMode::TextBottom, .. }) => 3,
                Some(Va { mode: VaMode::BaselineMiddle, .. }) => 4,
                _ => 0,
            };
            let figure = match va {
                Some(va) if code != 0 => self.parent_figure(c, va.mode)?,
                _ => 0.0,
            };
            let shift = if line_mode != 0 { 0.0 } else { va.map_or(0.0, |va| va.px) };
            let rec = self.inputs.len() as i32;
            self.record(c, g.idx)?;
            self.add_chain_rel(rec, g.rel.as_ref());
            g.runs.push(Pending::Atomic { ws: ws_mode, rec, shift, code, figure, line_mode });
            g.makes_line = true;
            return Ok(());
        }
        // (…its own `position: relative` offset joins the chain of the boxes it is in)
        let rel = self.chain_rel(c, cs, g.rel.as_ref())?;
        let cf = self.font_info(cs, g.block)?;
        // A `<br>` breaks the line, clearing the floats on the side it names; a `<wbr>` is a place it may. Each is an
        // inline box of its own with NO edges, whatever it declares.
        if tag == "br" || (tag == "wbr" && matches!(d.inside(), DisplayInside::Flow)) {
            let entry = self.entry(c, cs, &Edges::default(), rel.as_ref())?;
            if tag == "br" {
                let clear = self.clear_code(c, cs)?;
                g.runs.push(Pending::Br { ws: ws_mode, clear, entry });
                g.makes_line = true;
            } else {
                g.runs.push(Pending::Wbr { ws: ws_mode, entry });
            }
            return Ok(());
        }
        // (…an inline box holding a block-level box is laid out as a block, which its block's classification took)
        if self.holds_block_level(c)? {
            return Err("block-level-box-in-inline-content");
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
        let entry = self.entry(c, cs, &edges, rel.as_ref())?;
        g.runs.push(Pending::Open { plain: if edged { plain_open } else { 0.0 }, ws: c_ws, entry });
        let outer = g.makes_line;
        g.makes_line = false;
        // Its `vertical-align` moves the baseline of the text it owns — a shift by itself, an alignment against the
        // parent's font by the distance that takes its text's baseline there, a line-relative one not at all.
        let va = self.vertical_align(c, cs)?;
        let c_shift = match va {
            None => 0.0,
            Some(Va { mode: VaMode::Shift, px }) => px,
            Some(va) => self.inline_ascent(c, cs, Some(va), cf.asc)? - cf.asc,
        };
        let kids: Vec<NodeId> = self.children(c).collect();
        let outer_rel = std::mem::replace(&mut g.rel, rel);
        let gathered = self.gather(&kids, cs, &cf, c_ws, c_wrap, c_shift, g);
        g.rel = outer_rel;
        gathered?;
        g.makes_line = outer || g.makes_line || edged;
        let (own_h, own_asc) = if edged && close_lands {
            let face = self.face(cs)?;
            (content_height(cs, &face), self.inline_ascent(c, cs, va, content_ascent(cs, &face))?)
        } else {
            (0.0, 0.0)
        };
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

    // An inline box's entry: its edges — lengths, fractions and programs — its own font box and
    // ascent, and the relative offset its fragments take.
    fn entry(&mut self, c: NodeId, cs: &ComputedValues, e: &Edges, rel: Option<&Rel>) -> Result<usize, &'static str> {
        let face = self.face(cs)?;
        let va = self.vertical_align(c, cs)?;
        let own_asc = self.inline_ascent(c, cs, va, content_ascent(cs, &face))?;
        let math = std::array::from_fn(|k| self.math(e.math[k].as_deref()));
        let none = Rel::default();
        let rel = rel.unwrap_or(&none);
        let rel_math = [self.math(rel.xm.as_deref()), self.math(rel.ym.as_deref())];
        self.entry_el.push(c);
        self.entries.push(InlineBox {
            ml: e.ml,
            right: e.right,
            mr: e.mr,
            top: e.top,
            bottom: e.bottom,
            own_h: content_height(cs, &face),
            own_asc,
            rel_x: rel.x,
            rel_y: rel.y,
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
            rel_xf: rel.xf,
            rel_yf: rel.yf,
            rel_yi: rel.yi,
            rel_math,
        });
        Ok(self.entries.len() - 1)
    }

    // `owner`'s font as a run takes it, its tab stops counted in `block`'s.
    fn font_info(&mut self, owner: &ComputedValues, block: &ComputedValues) -> Result<FontInfo, &'static str> {
        let face = self.face(owner)?;
        let f = owner.get_font();
        let size = font_size(owner);
        let ls = spacing(&owner.get_inherited_text().letter_spacing.0, owner);
        let ws = spacing(&owner.get_inherited_text().word_spacing, owner);
        use style::values::generics::font::GenericLineHeight as LineHeight;
        let lh = match &f.line_height {
            LineHeight::Normal => js_round(face.asc * size) + js_round(face.desc * size) + js_round(face.gap * size),
            LineHeight::Number(n) => js_round(f32_exact(n.0) * size),
            LineHeight::Length(l) => js_round(f32_exact(l.0.px())),
        };
        let asc = ((lh - (js_round(face.asc * size) + js_round(face.desc * size))) / 2.0).floor() + js_round(face.asc * size);
        // The tab stops: the BLOCK's font counts the spaces and gives the half-space minimum, the owner's `tab-size`
        // says how many.
        let block_face = self.face(block)?;
        let bls = spacing(&block.get_inherited_text().letter_spacing.0, block);
        let bws = spacing(&block.get_inherited_text().word_spacing, block);
        let bare = block_face.space * font_size(block);
        let unit_space = bare + bls + bws;
        use style::values::generics::length::GenericLengthOrNumber as LengthOrNumber;
        let raw = match &owner.get_inherited_text().tab_size {
            LengthOrNumber::Number(n) => f32_exact(n.0) * unit_space,
            LengthOrNumber::Length(l) => f32_exact(l.0.px()),
        };
        let tab = if raw.is_finite() { if raw > 0.0 { raw } else { bls } } else { 8.0 * unit_space };
        let split = crate::font::with_font(face.handle, |m| m.is_split()).unwrap_or(false);
        Ok(FontInfo { face: face.handle, size, ls, ws, lh, asc, tab_px: tab.max(0.0), tab_min: bare / 2.0, split })
    }

    // The line box a text node needs where its font splits its characters across faces by `unicode-range`: the deepest
    // ascent and descent among the faces they select, each laid out as a face of its own would be
    // (`font::FontMetrics::run_vmax`) — a size-adjusted face that is not the primary still raises the line. None outside
    // a split. Asked per text NODE, of its data as written: two nodes merge into one run only where it is the same. A
    // node of white space that collapses is no run there — at most the one space of a gap, which sits on the owner's own
    // line box — so it raises nothing.
    fn split_vmax(&mut self, owner: &ComputedValues, font: &FontInfo, text: &[u16], ws_mode: u8) -> Result<Option<(f64, f64)>, &'static str> {
        if !font.split || !(has_content(text) || white_space_only_is_content(text, ws_mode)) {
            return Ok(None);
        }
        let face = self.face(owner)?;
        let primary = (!face.asc.is_nan()).then_some(crate::font::VerticalMetrics { asc: face.asc, desc: face.desc, gap: face.gap });
        use style::values::generics::font::GenericLineHeight as LineHeight;
        let fixed = (!matches!(owner.get_font().line_height, LineHeight::Normal)).then_some(font.lh);
        Ok(crate::font::with_font(font.face, |m| m.run_vmax(text, font.size, fixed, primary)).flatten())
    }

    // The face `style`'s font resolves to, as the JS side resolved it for its family and bucket.
    fn face(&mut self, style: &ComputedValues) -> Result<Face, &'static str> {
        let key = face_key(style.get_font());
        match self.faces.known.get(&key) {
            Some(Some(face)) => Ok(*face),
            Some(None) => Err("run-font-not-system"),
            // (…one not asked yet is noted, and the walk goes on with a stand-in, so ONE walk names every face the pass
            // needs: `build` answers NeedsFaces rather than records built with it)
            None => {
                if !self.faces.missing.contains(&key) {
                    self.faces.missing.push(key);
                }
                Ok(Face { handle: -1, asc: 0.0, desc: 0.0, gap: 0.0, space: 0.0, xh: 0.5 })
            }
        }
    }

    // A box's resolved `vertical-align`: None on the baseline, else its
    // mode and the SHIFT it carries — its own (`sub` / `super` by the parent's font size, a length, a percentage of
    // its own line height) plus the one the inline box it is in carries, which a box that declares nothing still
    // takes (the shorthand's two longhands, `baseline-shift` and `alignment-baseline`, in the style engine).
    fn vertical_align(&mut self, id: NodeId, style: &ComputedValues) -> Result<Option<Va>, &'static str> {
        use style::values::generics::box_::{BaselineShiftKeyword, GenericBaselineShift as BaselineShift};
        use style::values::specified::box_::AlignmentBaseline;
        let inherited = self.inline_parent_shift(id)?;
        let b = style.get_box();
        let aligned = match b.alignment_baseline {
            AlignmentBaseline::Baseline => None,
            AlignmentBaseline::Middle => Some(VaMode::Middle),
            AlignmentBaseline::TextTop => Some(VaMode::TextTop),
            AlignmentBaseline::TextBottom => Some(VaMode::TextBottom),
            AlignmentBaseline::MozMiddleWithBaseline => Some(VaMode::BaselineMiddle),
            // (…`central` the middle of the box, its nearest the model has; the other baselines — alphabetic,
            // ideographic, mathematical — are the one baseline a face's metrics give here)
            AlignmentBaseline::Central => Some(VaMode::Middle),
            _ => None,
        };
        let shift = match &b.baseline_shift {
            BaselineShift::Length(lp) if lp.to_length().is_some_and(|l| l.px() == 0.0) || lp.to_percentage().is_some_and(|p| p.0 == 0.0) => None,
            BaselineShift::Length(lp) => {
                let s = spec(lp)?;
                let basis = if s.frac != 0.0 || s.prog.is_some() { self.font_info(style, style)?.lh } else { 0.0 };
                Some(Va { mode: VaMode::Shift, px: spec_at(&s, basis) })
            }
            BaselineShift::Keyword(k @ (BaselineShiftKeyword::Sub | BaselineShiftKeyword::Super)) => {
                let size = self.parent_font_size(id)?;
                let own = if matches!(k, BaselineShiftKeyword::Super) { size / 3.0 + 1.0 } else { -(size / 5.0 + 1.0) };
                Some(Va { mode: VaMode::Shift, px: own })
            }
            BaselineShift::Keyword(BaselineShiftKeyword::Top) => Some(Va { mode: VaMode::Top, px: 0.0 }),
            BaselineShift::Keyword(BaselineShiftKeyword::Bottom) => Some(Va { mode: VaMode::Bottom, px: 0.0 }),
            // (…`center` the middle of the line box, its nearest the model has)
            BaselineShift::Keyword(BaselineShiftKeyword::Center) => Some(Va { mode: VaMode::Middle, px: 0.0 }),
        };
        Ok(match (aligned, shift) {
            // (…an alignment AND a shift: the box aligned, then shifted from there — CSS Inline 3 applies
            // `baseline-shift` after `alignment-baseline` — and a line-relative shift wins outright)
            (Some(mode), Some(Va { mode: VaMode::Shift, px })) if px.is_finite() => Some(Va { mode, px: px + inherited }),
            (Some(_), Some(Va { mode, .. })) => Some(Va { mode, px: inherited }),
            (Some(mode), None) => Some(Va { mode, px: inherited }),
            (None, Some(Va { mode: VaMode::Shift, px })) if px.is_finite() => Some(Va { mode: VaMode::Shift, px: px + inherited }),
            (None, Some(Va { mode, .. })) if mode != VaMode::Shift => Some(Va { mode, px: inherited }),
            _ if inherited != 0.0 => Some(Va { mode: VaMode::Shift, px: inherited }),
            _ => None,
        })
    }
    // The shift the inline box a box sits in carries: a BLOCK ends the walk.
    fn inline_parent_shift(&mut self, id: NodeId) -> Result<f64, &'static str> {
        let Some(p) = self.parent_of(id) else { return Ok(0.0) };
        if self.node(p).kind != NodeKind::Element {
            return Ok(0.0);
        }
        let ps = self.style(p)?;
        let d = self.laid_display(p, ps.get_box());
        if !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow))
            || replaced_or_control(self.arena, p, self.node(p))
            || self.holds_block_level(p)?
        {
            return Ok(0.0);
        }
        Ok(match self.vertical_align(p, &ps)? {
            Some(Va { mode: VaMode::Shift, px }) => px,
            _ => 0.0,
        })
    }
    // Where an inline box's font box reaches above the baseline, `vertical-align` included: a shift moves it; `middle`,
    // `text-top` and `text-bottom` place it against the PARENT's font.
    fn inline_ascent(&mut self, id: NodeId, style: &ComputedValues, va: Option<Va>, base: f64) -> Result<f64, &'static str> {
        let Some(va) = va else { return Ok(base) };
        let outer = content_height(style, &self.face(style)?);
        Ok(match va.mode {
            VaMode::Top | VaMode::Bottom => base,
            VaMode::Shift => base + va.px,
            VaMode::Middle => outer / 2.0 + self.parent_figure(id, va.mode)? + va.px,
            VaMode::TextTop => self.parent_figure(id, va.mode)? + va.px,
            VaMode::TextBottom => outer - self.parent_figure(id, va.mode)? + va.px,
            VaMode::BaselineMiddle => outer / 2.0 + va.px,
        })
    }
    // The one figure of the parent's font an alignment against it reads: half its x-height for
    // `middle`, its ascent for `text-top`, its descent for `text-bottom`.
    fn parent_figure(&mut self, id: NodeId, mode: VaMode) -> Result<f64, &'static str> {
        let p = self.parent_of(id).filter(|&p| self.node(p).kind == NodeKind::Element).unwrap_or(id);
        let ps = self.style(p)?;
        let face = self.face(&ps)?;
        let size = font_size(&ps);
        Ok(match mode {
            VaMode::Middle => size * face.xh / 2.0,
            VaMode::TextTop => js_round(face.asc * size),
            VaMode::TextBottom => js_round(face.desc * size),
            _ => 0.0,
        })
    }
    // …and its font size (`sub` / `super` shift by the PARENT's font).
    fn parent_font_size(&self, id: NodeId) -> Result<f64, &'static str> {
        let p = self.parent_of(id).filter(|&p| self.node(p).kind == NodeKind::Element).unwrap_or(id);
        let ps = self.style(p)?;
        Ok(font_size(&ps))
    }

    // The chain of relative offsets an inline box's content moves with: the boxes' around it, and its own where it is
    // `position: relative`.
    fn chain_rel(&self, id: NodeId, style: &ComputedValues, base: Option<&Rel>) -> Result<Option<Rel>, &'static str> {
        if style.get_box().clone_position() != Position::Relative {
            return Ok(base.cloned());
        }
        Ok(match inline_rel_spec(style, self.flow_relative_rtl(id)?)? {
            None => base.cloned(),
            Some(own) => Some(base.cloned().unwrap_or_default().plus(&own)),
        })
    }
    // …onto an ATOMIC's or a FLOAT's record, whose containing block is the same block: its lengths
    // into the base its own offset is added to and beside it, its fractions and programs beside them.
    fn add_chain_rel(&mut self, rec: i32, rel: Option<&Rel>) {
        let Some(rel) = rel else { return };
        let xm = rel.xm.as_ref().map(|p| self.chain_program(rec, 0, p));
        let ym = rel.ym.as_ref().map(|p| self.chain_program(rec, 1, p));
        let r = &mut self.inputs[rec as usize];
        r.rel_x += rel.x;
        r.rel_y += rel.y;
        r.rel_pct[5] = r.rel_x;
        r.rel_pct[6] = r.rel_y;
        r.chain_px[0] += rel.x;
        r.chain_px[1] += rel.y;
        r.chain_shift = r.chain_px;
        r.chain_rel[0] += rel.xf;
        r.chain_rel[1] += rel.yf;
        r.chain_rel[2] += rel.yi - rel.y;
        if let Some(m) = xm {
            r.chain_math[0] = m;
        }
        if let Some(m) = ym {
            r.chain_math[1] = m;
        }
    }
    // (…a record's chain program summed with one more share)
    fn chain_program(&mut self, rec: i32, axis: usize, share: &[f64]) -> u32 {
        let at = self.inputs[rec as usize].chain_math[axis];
        let prog = match program_at(&self.maths, at) {
            Some(existing) => [existing, share, &[MATH_SUM, 0.0, 0.0]].concat(),
            None => share.to_vec(),
        };
        self.math(Some(&prog))
    }

    // Does a non-replaced `display: inline` box hold a block-level box among its in-flow children — and so lay out as
    // a BLOCK (the nearest this model comes to CSS 2.1 §9.2.1.1's split)?
    fn holds_block_level(&self, id: NodeId) -> Result<bool, &'static str> {
        if replaced_or_control(self.arena, id, self.node(id)) {
            return Ok(false);
        }
        for c in self.children(id) {
            if self.node(c).kind == NodeKind::Element && self.is_block_level_child(c)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    // …a block-level box in flow (`isBlockLevelChild`): not an inline-level one, not a float, not out of flow — an
    // inline box that itself holds one among them.
    fn is_block_level_child(&self, id: NodeId) -> Result<bool, &'static str> {
        let style = self.style(id)?;
        let b = style.get_box();
        let d = self.laid_display(id, b);
        if d.is_none() || matches!(b.clone_position(), Position::Absolute | Position::Fixed) || b.clone_float() != Float::None {
            return Ok(false);
        }
        if matches!(d.outside(), DisplayOutside::Inline) {
            return Ok(matches!(d.inside(), DisplayInside::Flow) && self.holds_block_level(id)?);
        }
        Ok(true)
    }

    // The side a box floats to: 0 none, 1 left, 2 right — a flow-relative one by the direction of the
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
    // …and the side it clears: 0 none, 1 left, 2 right, 3 both.
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
        let mut cur = self.parent_of(id);
        while let Some(p) = cur {
            let node = self.node(p);
            if node.kind != NodeKind::Element {
                return Ok(false);
            }
            let ps = self.style(p)?;
            let d = self.laid_display(p, ps.get_box());
            if !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)) {
                return Ok(ps.get_inherited_box().direction == Direction::Rtl);
            }
            cur = self.parent_of(p);
        }
        Ok(false)
    }

    // Does the element establish a block formatting context? Asked of a block-level
    // `flow` / `flow-root` box, which is all this walk takes: in flow, floated or out of flow.
    fn establishes_bfc(&self, id: NodeId, style: &ComputedValues) -> bool {
        let node = self.node(id);
        let parent_is_element = self.parent_of(id).and_then(|p| self.get(p)).is_some_and(|p| p.kind == NodeKind::Element);
        if !parent_is_element {
            return true;
        }
        if OWN_CONTEXT_TAGS.contains(&node.rendering_tag()) {
            return true;
        }
        let b = style.get_box();
        // (…every box but an ordinary block or inline one: a caption's flow is its own too, and so is a `-webkit-box`'s,
        // laid out as a block but no ordinary one, so its own display decides)
        let raw = b.clone_display();
        // (…a ruby box by the inline `walk_display` lays it out as; a `-webkit-box` by its own display, a block of its own)
        let d = if matches!(raw.inside(), DisplayInside::WebkitBox) { raw } else { self.laid_display(id, b) };
        if !matches!(d.inside(), DisplayInside::Flow) || !matches!(d.outside(), DisplayOutside::Block | DisplayOutside::Inline) {
            return true;
        }
        if b.clone_float() != Float::None || matches!(b.clone_position(), Position::Absolute | Position::Fixed) {
            return true;
        }
        if self.clip_flags(id, style) != 0 {
            return true;
        }
        if let Some(p) = self.layout_parent(id) {
            if let Ok(ps) = self.style(p) {
                if self.laid_display(p, ps.get_box()).is_item_container() {
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

    // How the box clips its content (`Input::clip`): per axis, where its overflow is not `visible` once the viewport has
    // taken the root's, and the body's where the root has none of its own (CSS Overflow 3 §3.3) — and whether it is a
    // SCROLL CONTAINER, which is not the same question: `clip` clips and forbids all scrolling, script included, so it is
    // neither the scrollport a sticky box sticks within nor one a script can scroll. The axes are kept apart because
    // `clip` beside `visible` stays so, and a child hanging off the SIDE of an `overflow-y: clip` box is visible.
    fn clip_flags(&self, id: NodeId, style: &ComputedValues) -> u8 {
        use crate::layout::{CLIP_SCROLLS, CLIP_X, CLIP_Y};
        let node = self.node(id);
        // (…`overflow` applies to no inline box — one laid out as a block for the block it holds among them)
        let d = self.laid_display(id, style.get_box());
        if matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow) {
            return 0;
        }
        let visible = |s: &ComputedValues| s.get_box().overflow_x == Overflow::Visible && s.get_box().overflow_y == Overflow::Visible;
        let parent = self.parent_of(id).and_then(|p| self.get(p).map(|n| (p, n)));
        match parent {
            Some((_, pn)) if pn.kind == NodeKind::Document => return 0,
            Some((p, pn)) if node.rendering_tag() == "body" && pn.is_html_named("html") && self.parent_of(p).and_then(|d| self.get(d)).is_some_and(|d| d.kind == NodeKind::Document) => {
                if self.style(p).is_ok_and(|ps| visible(&ps)) {
                    return 0;
                }
            }
            _ => {}
        }
        let b = style.get_box();
        let mut flags = 0;
        if b.overflow_x != Overflow::Visible {
            flags |= CLIP_X;
        }
        if b.overflow_y != Overflow::Visible {
            flags |= CLIP_Y;
        }
        if scrolls(b.overflow_x) || scrolls(b.overflow_y) {
            flags |= CLIP_SCROLLS;
        }
        flags
    }

    // HTML's LEGACY alignment for this block's block-level descendants: `<center>`, or an `align` on a `div` / `p` /
    // heading, the nearest ancestor-or-self deciding (`Input::legacy_align`: 1 center, 2 right, 3 left).
    fn legacy_align(&self, id: NodeId) -> u8 {
        let mut cur = Some(id);
        while let Some(at) = cur {
            let Some(node) = self.get(at) else { break };
            if node.kind != NodeKind::Element {
                break;
            }
            let tag = node.rendering_tag();
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
            cur = self.parent_of(at);
        }
        0
    }
}

// A fresh record, before the walk fills it in: every number 0 and every flag off, but the declared sizes, the
// flex basis, the insets, a row's height and the percentages to resolve absent (NaN), no comparison program
// anywhere, and no containing block in the pass.
pub(crate) fn fresh_record() -> Input {
    use crate::layout::NO_MATH;
    let nan = f64::NAN;
    Input {
        nid: 0.0,
        parent: 0,
        display: 0,
        border_box: false,
        width: 0.0,
        height: 0.0,
        min_w: 0.0,
        max_w: 0.0,
        min_h: 0.0,
        max_h: 0.0,
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
        height_adjoins: false,
        minh_adjoins: false,
        bottom_adjoins: false,
        run_start: 0,
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
        flex_main_is_x: false,
        flex_wrap: false,
        flex_cross_flip: false,
        flex_align_content: 0,
        flex_cross_gap: 0.0,
        flex_main_reverse: false,
        flex_cross_far: false,
        rel_x: 0.0,
        rel_y: 0.0,
        rel_pct: [nan, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        rel_x_px: 0.0,
        rel_x_neg: false,
        chain_rel: [0.0; 3],
        chain_px: [0.0; 2],
        chain_shift: [0.0; 2],
        chain_math: [NO_MATH; 2],
        rel_math: [NO_MATH; 3],
        flex_item_auto: 0,
        out_of_flow: 0,
        sp_x: 0.0,
        sp_y: 0.0,
        cell_col: 0,
        cell_colspan: 0,
        cell_rowspan: 0,
        caption_side: 0,
        rtl: 0,
        text_align: 0,
        ws_mode: 0,
        item_auto_height: false,
        grid_start: 0,
        decl_w: nan,
        decl_min_w: nan,
        decl_max_w: nan,
        flex_basis: nan,
        flex_grow: 0.0,
        decl_border_box: false,
        flex_shrink: 0.0,
        flex_basis_cb: 0.0,
        flex_basis_frac: nan,
        flex_basis_math: NO_MATH,
        pct_sizes: [nan; 6],
        pct_px: [0.0; 6],
        pct_math: [NO_MATH; 6],
        edge_frac: [0.0; 8],
        edge_px: [0.0; 8],
        edge_math: [NO_MATH; 8],
        basis_w: nan,
        inset_frac: [0.0; 4],
        inset_math: [NO_MATH; 4],
        flex_main_gap_frac: 0.0,
        flex_main_gap_math: NO_MATH,
        flex_cross_gap_math: NO_MATH,
        indent_math: NO_MATH,
        flex_cross_gap_frac: 0.0,
        flex_basis_kw: 0,
        scrolls_x: false,
        scrolls_y: false,
        clip: 0,
        is_button: false,
        self_sizes: false,
        block_axis_is_x: false,
        decl_edges_x: 0.0,
        decl_margin_x: 0.0,
        height_from_outside: false,
        cell_pct: 0.0,
        height_is_floor: false,
        cell_valign: 0,
        cell_pct_h_child: false,
        anon_group: false,
        group_pct_h: nan,
        pct_h_decl: false,
        row_imposed: false,
        row_height: nan,
        row_pct: nan,
        row_rank: 0,
        table_fixed: false,
        flex_stretch: false,
        flex_dir_reverse: false,
        replaced: false,
        lays_out_children: false,
        ratio: false,
        ratio_only: false,
        shrinks_to_nothing: false,
        form_control: false,
        control_baseline: 0,
        control_font_box: 0.0,
        control_font_asc: 0.0,
        text_overflows: false,
        intrinsic_w: 0.0,
        intrinsic_h: 0.0,
        cb_index: -1,
        inset_top: nan,
        inset_right: nan,
        inset_bottom: nan,
        inset_left: nan,
        fits_content: 0,
        auto_margins: 0,
        legacy_align: 0,
        legend_align: 0,
        indent_px: 0.0,
        indent_frac: 0.0,
        indent_hanging: false,
        indent_each_line: false,
        indent_spent: false,
        width_kw: 0,
        height_kw: false,
        cb_rect: [0.0; 4],
    }
}

// A box's four margins then four paddings as length-percentages (None for an `auto` margin), and which margins are
// `auto` (`Input::auto_margins`: 1 left, 2 right, 4 top, 8 bottom).
pub(crate) fn edge_lps(style: &ComputedValues) -> Result<([Option<&LengthPercentage>; 8], u8), &'static str> {
    use style::values::generics::length::GenericMargin as Margin;
    let m = style.get_margin();
    let p = style.get_padding();
    let mut edges: [Option<&LengthPercentage>; 8] = [None; 8];
    let mut auto = 0u8;
    for (k, margin) in [&m.margin_top, &m.margin_right, &m.margin_bottom, &m.margin_left].into_iter().enumerate() {
        match margin {
            Margin::Auto => auto |= [4, 2, 8, 1][k],
            Margin::LengthPercentage(lp) => edges[k] = Some(lp),
            // (…an `anchor-size()` margin with no anchor to size it — none is modelled — is its FALLBACK, and with none
            // invalid at computed-value time: the initial 0. Chrome: `anchor-size(--a width, 25px)` is 25.)
            Margin::AnchorSizeFunction(f) => match &f.fallback {
                // (…a `<length-percentage>` fallback only: an `auto` one is no fallback the grammar takes, and Chrome drops the
                // declaration)
                style::values::generics::Optional::Some(Margin::LengthPercentage(lp)) => edges[k] = Some(lp),
                _ => {}
            },
            Margin::AnchorContainingCalcFunction(_) => {}
        }
    }
    for (k, padding) in [&p.padding_top, &p.padding_right, &p.padding_bottom, &p.padding_left].into_iter().enumerate() {
        edges[4 + k] = Some(&padding.0);
    }
    Ok((edges, auto))
}
// The USED border widths, top right bottom left: the computed one is a length whatever the style (css-backgrounds-3),
// and a `none` / `hidden` side draws none.
pub(crate) fn used_borders(style: &ComputedValues) -> [f64; 4] {
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
// A run that is an inline box's edge or a break: its entry, the edge with no basis, its mode.
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
// Two runs' fonts one run can hold.
fn same_font(a: &FontInfo, b: &FontInfo) -> bool {
    a.face == b.face && a.size == b.size && a.ls == b.ls && a.ws == b.ws && a.lh == b.lh && a.tab_px == b.tab_px && a.tab_min == b.tab_min
}
// The face's content box at the element's size (ascent + descent, each rounded) and its ascent (what `inline_ascent`
// answers of a box on the baseline).
fn content_height(style: &ComputedValues, face: &Face) -> f64 {
    let size = font_size(style);
    js_round(face.asc * size) + js_round(face.desc * size)
}
fn content_ascent(style: &ComputedValues, face: &Face) -> f64 {
    js_round(face.asc * font_size(style))
}
// The used font size: the computed one, 16 where that is 0.
fn font_size(style: &ComputedValues) -> f64 {
    match f32_exact(style.get_font().font_size.computed_size().px()) {
        0.0 => 16.0,
        s => s,
    }
}

// Why a display this walk has not been taught declines, by what it lays out.
fn display_decline(d: style::values::specified::box_::Display) -> &'static str {
    match (d.outside(), d.inside()) {
        (_, DisplayInside::Flex) => "flex",
        (_, DisplayInside::Grid) => "grid",
        (_, DisplayInside::Table) => "table",
        (DisplayOutside::TableCaption, _) => "table caption",
        (DisplayOutside::InternalTable, _) => "table part",
        (DisplayOutside::Inline, _) => "atomic inline",
        _ => "display",
    }
}

// An inline box's own relative offset as the chain carries it: None where it moves nothing.
// Where no inset has a percentage, it is its lengths; else each side's share — its pair (a fraction of `None` where
// there is no percentage in it: `top` then falls back to `bottom` nowhere) or its program — `left`, else `right`
// negated by the containing block's direction (`rtl`), `top`, else `bottom` negated, with `yi` what an indefinite height
// leaves.
fn inline_rel_spec(style: &ComputedValues, rtl: bool) -> Result<Option<Rel>, &'static str> {
    let pos = style.get_position();
    let [top, right, bottom, left] = [inset_lp(&pos.top)?, inset_lp(&pos.right)?, inset_lp(&pos.bottom)?, inset_lp(&pos.left)?];
    let keep_right = right.is_some() && (left.is_none() || rtl);
    if ![top, right, bottom, left].iter().flatten().any(|lp| lp.has_percentage()) {
        let px = |lp: Option<&LengthPercentage>| lp.map_or(Ok(0.0), length);
        let x = if keep_right { -px(right)? } else { px(left)? };
        let y = if top.is_some() { px(top)? } else { -px(bottom)? };
        return Ok((x != 0.0 || y != 0.0).then(|| Rel { x, y, yi: y, ..Rel::default() }));
    }
    // A side's share, as `(px, frac, prog)`: a line, or a comparison's whole program.
    let side = |lp: &LengthPercentage| -> Result<(f64, Option<f64>, Option<Vec<f64>>), &'static str> {
        let s = spec(lp)?;
        Ok(match s.prog {
            Some(prog) => (0.0, Some(0.0), Some(prog)),
            None => (s.px, lp.has_percentage().then_some(s.frac), None),
        })
    };
    let share = |a: (f64, Option<f64>, Option<Vec<f64>>), neg: bool| {
        let k = if neg { -1.0 } else { 1.0 };
        let prog = a.2.map(|mut p| {
            if neg {
                p.extend([MATH_NEG, 0.0, 0.0]);
            }
            p
        });
        (k * a.0, k * a.1.unwrap_or(0.0), prog)
    };
    let x = if keep_right { share(side(right.unwrap())?, true) } else if let Some(l) = left { share(side(l)?, false) } else { (0.0, 0.0, None) };
    let (top_s, bottom_s) = (top.map(side).transpose()?, bottom.map(side).transpose()?);
    // (…what an INDEFINITE height leaves: a length `top`, else — a percentage `top` being `auto` there — a length
    // `bottom`)
    let yi = match (&top_s, &bottom_s) {
        (Some((px, None, _)), _) => *px,
        (_, Some((px, None, _))) => -px,
        _ => 0.0,
    };
    let y = match (top_s, bottom_s) {
        (Some(t), _) => share(t, false),
        (None, Some(b)) => share(b, true),
        (None, None) => (0.0, 0.0, None),
    };
    Ok(Some(Rel { x: x.0, xf: x.1, y: y.0, yf: y.1, yi, xm: x.2, ym: y.2 }))
}

// An inset's length-percentage, None for `auto`.
pub(crate) fn inset_lp(v: &style::values::computed::position::Inset) -> Result<Option<&LengthPercentage>, &'static str> {
    use style::values::generics::position::GenericInset as Inset;
    use style::values::generics::Optional;
    match v {
        Inset::LengthPercentage(lp) => Ok(Some(lp)),
        Inset::Auto => Ok(None),
        // (…an `anchor()` / `anchor-size()` inset with no anchor to place it — none is modelled — is its FALLBACK, and
        // with none invalid at computed-value time: the initial `auto`. Chrome: `top: anchor(--a bottom, 30px)` with no
        // `--a` is 30.)
        Inset::AnchorFunction(f) => match &f.fallback {
            Optional::Some(fallback) => inset_lp(fallback),
            Optional::None => Ok(None),
        },
        Inset::AnchorSizeFunction(f) => match &f.fallback {
            Optional::Some(fallback) => inset_lp(fallback),
            Optional::None => Ok(None),
        },
        Inset::AnchorContainingCalcFunction(_) => Ok(None),
    }
}
// Does the box contain its out-of-flow descendants, fixed ones included (`containsOutOfFlow`): a filter, a transform
// on a box it applies to, layout or paint containment, `content-visibility` other than visible, or a `will-change` that
// promises one.
pub(crate) fn contains_out_of_flow(style: &ComputedValues, arena: &RealmArena, id: NodeId, node: &crate::dom::NodeData) -> bool {
    use style::values::computed::Contain;
    let effects = style.get_effects();
    if !effects.filter.0.is_empty() || !effects.backdrop_filter.0.is_empty() {
        return true;
    }
    let b = style.get_box();
    let d = b.walk_display(node.rendering_tag());
    // (…a block-holding inline among the inline boxes it does not apply to: it is laid out as a block, and is an
    // inline box to everything but the flow — `isSplitInline`)
    let transformable = !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow) && !replaced_or_control(arena, id, node))
        && !matches!(d.inside(), DisplayInside::TableColumn | DisplayInside::TableColumnGroup);
    // (…the rest only of a box they apply to: not a non-replaced inline, not a table column — `isTransformable`)
    if !transformable {
        return false;
    }
    if !b.transform.0.is_empty()
        || !matches!(b.perspective, style::values::generics::box_::GenericPerspective::None)
        || !matches!(b.translate, style::values::generics::transform::GenericTranslate::None)
        || !matches!(b.rotate, style::values::generics::transform::GenericRotate::None)
        || !matches!(b.scale, style::values::generics::transform::GenericScale::None)
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

// A size's length-percentage, None for `auto` / `none` / a keyword — and for an `anchor-size()`, which takes the size of
// an anchor the layout does not model (CSS Anchor Positioning): such a declaration is read as no size at all (a gap —
// the fallback a function carries, and a real anchor's size, are backlog).
pub(crate) fn size_lp(v: &style::values::computed::Size) -> Option<&LengthPercentage> {
    use style::values::generics::length::GenericSize as Size;
    match v {
        Size::LengthPercentage(lp) => Some(&lp.0),
        _ => None,
    }
}
fn max_size_lp(v: &style::values::computed::MaxSize) -> Option<&LengthPercentage> {
    use style::values::generics::length::GenericMaxSize as MaxSize;
    match v {
        MaxSize::LengthPercentage(lp) => Some(&lp.0),
        _ => None,
    }
}

// A COMPARISON program (evaluated by `layout::math_at`): postfix triples `[op, a, b]` —
// `MATH_LINE` pushes `a + b × basis`, `MATH_MIN` / `MATH_MAX` / `MATH_SUM` fold the top two, `MATH_NEG` negates the top
// and `MATH_SCALE` multiplies it by `a`. A piece with no comparison inside is ONE line, its `px + frac × basis`.

// A value the record carries for the layout to resolve at the basis it has: `px + frac × basis`, or its program (whose
// pair is then its figure at no basis).
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
        Unpacked::Length(l) => Ok(Spec { px: f32_exact(l.px()), frac: 0.0, prog: None }),
        Unpacked::Percentage(p) => Ok(Spec { px: 0.0, frac: f32_exact(p.0), prog: None }),
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
        Node::Leaf(Leaf::Length(l)) => Some((f32_exact(l.px()), 0.0)),
        Node::Leaf(Leaf::Percentage(p)) => Some((0.0, f32_exact(p.0))),
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
            Node::Leaf(Leaf::Number(n)) => scale *= f32_exact(*n),
            Node::Invert(inner) => match &**inner {
                Node::Leaf(Leaf::Number(n)) => scale /= f32_exact(*n),
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
    emit(node, &mut prog)?;
    Ok(prog)
}
fn emit(node: &CalcNode, prog: &mut Vec<f64>) -> Step {
    use style::values::generics::calc::{GenericCalcNode as Node, MinMaxOp};
    if let Some((px, frac)) = linear(node) {
        prog.extend([MATH_LINE, px, frac]);
        return Ok(());
    }
    let fold = |prog: &mut Vec<f64>, op: f64| prog.extend([op, 0.0, 0.0]);
    match node {
        Node::MinMax(args, op) => {
            let op = if matches!(op, MinMaxOp::Min) { MATH_MIN } else { MATH_MAX };
            for (i, a) in args.iter().enumerate() {
                emit(a, prog)?;
                if i > 0 {
                    fold(prog, op);
                }
            }
            if args.is_empty() {
                return Err("math function");
            }
        }
        // (…CSS's own `max(lo, min(v, hi))`: where the bounds cross, the minimum wins)
        Node::Clamp { min, center, max } => {
            emit(min, prog)?;
            emit(center, prog)?;
            emit(max, prog)?;
            fold(prog, MATH_MIN);
            fold(prog, MATH_MAX);
        }
        Node::Sum(terms) => {
            for (i, t) in terms.iter().enumerate() {
                emit(t, prog)?;
                if i > 0 {
                    fold(prog, MATH_SUM);
                }
            }
        }
        Node::Negate(n) => {
            emit(n, prog)?;
            prog.extend([MATH_NEG, 0.0, 0.0]);
        }
        Node::Product(factors) => match product(factors) {
            Some((scale, operand)) => {
                emit(operand, prog)?;
                if scale != 1.0 {
                    prog.extend([MATH_SCALE, scale, 0.0]);
                }
            }
            // (…a product of two operands that are not numbers — a percentage over a percentage is one — multiplies)
            None => {
                for (i, f) in factors.iter().enumerate() {
                    emit(f, prog)?;
                    if i > 0 {
                        fold(prog, crate::layout::MATH_MUL);
                    }
                }
            }
        },
        Node::Invert(n) => {
            emit(n, prog)?;
            prog.extend([crate::layout::MATH_INV, 0.0, 0.0]);
        }
        Node::Abs(n) => {
            emit(n, prog)?;
            prog.extend([crate::layout::MATH_ABS, 0.0, 0.0]);
        }
        Node::Sign(n) => {
            emit(n, prog)?;
            prog.extend([crate::layout::MATH_SIGN, 0.0, 0.0]);
        }
        Node::Round { strategy, value, step } => {
            use style::values::generics::calc::RoundingStrategy as Strategy;
            emit(value, prog)?;
            emit(step, prog)?;
            fold(prog, match strategy {
                Strategy::Nearest => crate::layout::MATH_ROUND_NEAREST,
                Strategy::Up => crate::layout::MATH_ROUND_UP,
                Strategy::Down => crate::layout::MATH_ROUND_DOWN,
                Strategy::ToZero => crate::layout::MATH_ROUND_TO_ZERO,
            });
        }
        Node::ModRem { dividend, divisor, op } => {
            use style::values::generics::calc::ModRemOp;
            emit(dividend, prog)?;
            emit(divisor, prog)?;
            fold(prog, if matches!(op, ModRemOp::Mod) { crate::layout::MATH_MOD } else { crate::layout::MATH_REM });
        }
        Node::Hypot(args) => {
            for (i, a) in args.iter().enumerate() {
                emit(a, prog)?;
                if i > 0 {
                    fold(prog, crate::layout::MATH_HYPOT);
                }
            }
            if args.is_empty() {
                return Err("math function");
            }
            // (…one argument is its absolute value)
            if args.len() == 1 {
                prog.extend([crate::layout::MATH_ABS, 0.0, 0.0]);
            }
        }
        Node::Pow(base, exponent) => {
            emit(base, prog)?;
            emit(exponent, prog)?;
            fold(prog, crate::layout::MATH_POW);
        }
        Node::Sqrt(n) => {
            emit(n, prog)?;
            prog.extend([crate::layout::MATH_SQRT, 0.0, 0.0]);
        }
        // (…a bare number among them: an operand of the plain value it is)
        Node::Leaf(style::values::computed::length_percentage::ComputedLeaf::Number(n)) => {
            prog.extend([MATH_LINE, f32_exact(*n), 0.0]);
        }
        _ => return Err("math function"),
    }
    Ok(())
}
// A program at a basis — the layout's own evaluation (`layout::math_at`), which is what it will come to there.
fn math_at(prog: &[f64], basis: f64) -> f64 {
    let mut table = Vec::with_capacity(prog.len() + 1);
    table.push((prog.len() / 3) as f64);
    table.extend_from_slice(prog);
    crate::layout::math_at(&table, 0, basis)
}

// The bases a box's edges are probed at, to hold the form the record carries them in to what they are (`EdgeParts`).
const EDGE_PROBE: f64 = 1_048_576.0;
const EDGE_CHECKS: [f64; 4] = [217.0, 1531.0, 4099.0, 30011.0];

// A box's four margins and four paddings as the record carries them: each one's length part, its fraction of the
// containing block's width, and its program where a comparison bends it.
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
        // (…held to what the edges ARE at the probes: a shape neither form reproduces is one the record cannot carry,
        // which this walk declines.)
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

// A style value as the page wrote it: the style engine keeps lengths, percentages and numbers as f32, where the page
// wrote a decimal — `40%` widened from its f32 is 0.4000000059604645, not 0.4, and a table row came out 40.00000059
// against Chrome's 40. The f32's SHORTEST decimal (the fewest significant digits that read back as it) is the value
// written wherever the page wrote one an f32 can hold, so that is what the record takes. Found by rounding, not by
// formatting: this runs for every length of every record, and a format and a parse per value cost a relayout of
// fractional lengths 8-17%. (A value DERIVED from one — an `em`, a `calc()` — is only the f32 the engine computed:
// exact to f32 precision, and no closer.)
pub(crate) fn f32_exact(v: f32) -> f64 {
    // (…an integer below 2^24 is every f32 in its range, so it IS the written one: the commonest value, skipped)
    if !v.is_finite() || (v == v.trunc() && v.abs() < 16_777_216.0) {
        return v as f64;
    }
    let x = v as f64;
    let magnitude = x.abs().log10().floor() as i32;
    for digits in 1..=9 {
        let scale = 10f64.powi(digits - 1 - magnitude);
        let rounded = (x * scale).round() / scale;
        if rounded as f32 == v {
            return rounded;
        }
    }
    x
}
// A length's px — a value with a percentage in it is not taught yet.
fn length(lp: &LengthPercentage) -> Result<f64, &'static str> {
    lp.to_length().map(|l: Length| f32_exact(l.px())).ok_or("percentage")
}
// A letter- or word-spacing's px: a PERCENTAGE is of `style`'s own font size (css-text-4 — `word-spacing: 50%` adds 8px
// at 16px, and Chrome takes one for `letter-spacing` too), and it inherits as the percentage, so each element resolves
// it against its own. Written as the JS side reduces it (`spacingToPx`: the written percentage over 100, times the font
// size), a `calc()` holding one resolved with its percentage as that px.
fn spacing(lp: &LengthPercentage, style: &ComputedValues) -> f64 {
    if let Some(l) = lp.to_length() {
        return f32_exact(l.px());
    }
    let fs = font_size(style);
    if let Some(p) = lp.to_percentage() {
        return f32_exact(p.0 * 100.0) / 100.0 * fs;
    }
    f32_exact(lp.resolve(Length::new(fs as f32)).px())
}
// Does a height leave the box's margins adjoining — `auto`, an intrinsic keyword, or a zero length?
fn auto_or_zero(v: &style::values::computed::Size) -> bool {
    use style::values::generics::length::GenericSize as Size;
    match v {
        Size::LengthPercentage(lp) => lp.0.to_length().is_some_and(|l| l.px() == 0.0) || lp.0.to_percentage().is_some_and(|p| p.0 == 0.0),
        // (…the intrinsic keywords are auto here, a `stretch` height a definite one)
        Size::Auto | Size::MinContent | Size::MaxContent | Size::FitContent => true,
        _ => false,
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
        // (…and the combinations no `white-space` value spells, by the lines they make: a `nowrap` that keeps its breaks
        // breaks there and nowhere else — `pre`'s lines, its spaces kept where Chrome collapses them (two unwrapped lines,
        // 44 tall) — and any other keeping its spaces `pre` or `pre-wrap`)
        (WhiteSpaceCollapse::PreserveBreaks, false) => WS_PRE,
        (_, wrap) => if wrap { WS_PRE_WRAP } else { WS_PRE },
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
// Does white space alone make a line under `mode`?
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
// The block's `text-indent` as the record takes it: its Spec and the hanging / each-line bits.
fn indent(style: &ComputedValues) -> Result<(Spec, u32), &'static str> {
    let ti = &style.get_inherited_text().text_indent;
    Ok((spec(&ti.length)?, (if ti.hanging { 256 } else { 0 }) | (if ti.each_line { 512 } else { 0 })))
}
// The line alignment code: 0 left, 1 right, 2 center, 3 justify.
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
// The in-word break mode: 0 none, 1 break-all, 2 break-word, 3 anywhere, 4 break-all + break-word,
// 5 break-all + anywhere.
fn wrap_mode(style: &ComputedValues) -> u8 {
    let t = style.get_inherited_text();
    let break_all = t.word_break == WordBreak::BreakAll;
    let wrap = t.overflow_wrap;
    if !(break_all || wrap != OverflowWrap::Normal) {
        return 0;
    }
    match (break_all, wrap) {
        (true, OverflowWrap::Normal) => 1,
        (true, OverflowWrap::Anywhere) => 5,
        (true, _) => 4,
        (false, OverflowWrap::Anywhere) => 3,
        _ => 2,
    }
}
// JavaScript's `Math.round`: halves go UP, toward +∞.
pub(crate) fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
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

#[cfg(test)]
mod tests {
    use super::f32_exact;

    // The decimal a page writes comes back as that decimal, not as the f32 nearest it; a value an f32 holds exactly
    // (an integer, a binary fraction) and one past its range pass through.
    #[test]
    fn f32_exact_reads_the_written_decimal() {
        assert_eq!(f32_exact(0.4), 0.4);
        assert_eq!(f32_exact(0.6), 0.6);
        assert_eq!(f32_exact(10.1), 10.1);
        assert_eq!(f32_exact(1.0 / 3.0), 0.33333334);
        assert_eq!(f32_exact(0.25), 0.25);
        assert_eq!(f32_exact(-37.5), -37.5);
        assert_eq!(f32_exact(1e-7), 1e-7);
        assert_eq!(f32_exact(3.0e38), 3.0e38);
        assert!(f32_exact(f32::NAN).is_nan());
        assert_eq!(f32_exact(f32::INFINITY), f64::INFINITY);
    }
}
