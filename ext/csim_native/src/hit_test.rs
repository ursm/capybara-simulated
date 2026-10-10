// The PAINTING ORDER of the last layout and the HIT TEST it decides (CSS 2.1 appendix E): which box is on top at a
// viewport point (`elementFromPoint`, Capybara's click target and its obscured check), and the order the painter draws
// the boxes in — one order, so painting and hit-testing agree about what is on top.
//
// A box is placed in its stacking context by a KEY compared entry by entry, a key that runs out first painting first:
// the stacking chain it lives in (each enclosing context or painting unit's phase and place in the tree), then its own
// phase and place. A layer is a box, or the CONTENT a box owns (its text runs and a replaced element's image), which
// paints in the inline phase of whatever the box paints inside.

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::style::StyleEngine;
use crate::geometry::{box_style, flat_parent, laid, laid_frags, laid_out_box, transform_chain, M4};
use crate::walk::WalkDisplay;
use std::collections::HashMap;
use style::properties::ComputedValues;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

// The phases within a stacking context (appendix E): the block-level backgrounds (step 4), the floats (step 5), the
// inline-level content (step 7), the positioned boxes of `z-index` auto or 0 (step 8) — and a context's own `z-index`
// below and above those.
const PAINT_BLOCK: f64 = 0.0;
const PAINT_FLOAT: f64 = 0.2;
const PAINT_INLINE: f64 = 0.3;
const PAINT_POSITIONED: f64 = 0.5;

// The properties whose CURRENT animation makes an element a stacking context while it runs, its delay included (Chrome:
// a `@keyframes` in its delay makes one for `clip-path`, none for `mask-image`, `mix-blend-mode` or `isolation`).
pub(crate) const STACKING_ANIMATED: [&str; 8] = ["transform", "translate", "rotate", "scale", "opacity", "filter", "backdrop-filter", "clip-path"];

// A paint key and how much of its chain the enclosing stacking contexts make up (`real`).
#[derive(Clone)]
struct Chain {
    key: Vec<f64>,
    real: usize,
}

// One question about the page's painting: the boxes in tree order (`order`, each box's place, the flex and grid items
// of a container in their order-modified order) and the chains asked so far.
pub(crate) struct Painting<'a> {
    arena: &'a RealmArena,
    // The realm's style engine, where it has one: what an element's animations and its `::backdrop` are asked of.
    engine: Option<&'a StyleEngine>,
    stacking_animated: Vec<String>,
    order: HashMap<NodeId, f64>,
    preorder: Vec<NodeId>,
    // …the index past each box's subtree in `preorder`.
    ends: Vec<usize>,
    chains: HashMap<NodeId, Chain>,
    // …and each box's painted rect, as an occlusion test found it (`painted_rect`).
    painted: HashMap<NodeId, Option<[f64; 4]>>,
}

impl<'a> Painting<'a> {
    pub(crate) fn new(arena: &'a RealmArena, engine: Option<&'a StyleEngine>) -> Painting<'a> {
        let mut p = Painting {
            arena,
            engine,
            stacking_animated: STACKING_ANIMATED.iter().map(|p| p.to_string()).collect(),
            order: HashMap::new(), preorder: Vec::new(), ends: Vec::new(), chains: HashMap::new(), painted: HashMap::new()
        };
        if let Some(root) = arena.layout_root {
            p.visit(root);
            p.order.insert(root, -1.0);
        }
        p
    }

    // Whether the modal dialog `id`'s `::backdrop` generates a box: not `display: none` (none asked of a realm without
    // a style engine, where it is taken to).
    fn has_backdrop(&self, id: NodeId) -> bool {
        self.engine.is_none_or(|e| e.pseudo_generates_box(self.arena, id, "backdrop"))
    }
    fn has_box(&self, id: NodeId) -> bool {
        self.arena.get(id).is_some_and(|n| laid(self.arena, n).is_some() || laid_frags(self.arena, n).is_some())
    }
    fn visit(&mut self, id: NodeId) {
        let at = self.preorder.len();
        self.order.insert(id, at as f64);
        self.preorder.push(id);
        self.ends.push(at + 1);
        for c in self.box_children(id) {
            self.visit(c);
        }
        self.ends[at] = self.preorder.len();
    }
    // The boxes an element's box holds, in the order they paint: its `::before`, its flat-tree children — a box-less one
    // replaced by its own — and its `::after`; a flex or grid container's in ORDER-MODIFIED document order (Flexbox §4.3,
    // Grid §9).
    fn box_children(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = crate::geometry::box_children(self.arena, id);
        let ordered = box_style(self.arena, id).is_some_and(|s| {
            let d = s.get_box().clone_display();
            matches!(d.inside(), DisplayInside::Flex | DisplayInside::Grid)
        });
        if ordered {
            out.sort_by_key(|&c| box_style(self.arena, c).map_or(0, |s| s.get_position().order));
        }
        out
    }

    fn style(&self, id: NodeId) -> Option<style::servo_arc::Arc<ComputedValues>> {
        box_style(self.arena, id)
    }
    fn order_of(&self, id: NodeId) -> f64 {
        self.order.get(&id).copied().unwrap_or(f64::NAN)
    }
    fn positioned(&self, s: &ComputedValues) -> bool {
        s.get_box().clone_position() != style::computed_values::position::T::Static
    }
    fn display(&self, id: NodeId, s: &ComputedValues) -> style::values::specified::box_::Display {
        s.get_box().walk_display(self.arena.get(id).map_or("", |n| n.rendering_tag()))
    }
    fn boxless(&self, id: NodeId) -> bool {
        self.style(id).is_none_or(|s| self.display(id, &s).is_contents())
    }
    // A flex or grid ITEM: an in-flow child of a box that lays its children out as items.
    fn item(&self, id: NodeId, s: &ComputedValues) -> bool {
        use style::computed_values::position::T as Position;
        if matches!(s.get_box().clone_position(), Position::Absolute | Position::Fixed) {
            return false;
        }
        let mut p = flat_parent(self.arena, id);
        while let Some(at) = p.filter(|&at| self.boxless(at) && self.arena.get(at).is_some_and(|n| n.kind == NodeKind::Element)) {
            p = flat_parent(self.arena, at);
        }
        p.and_then(|p| self.style(p).map(|ps| self.display(p, &ps))).is_some_and(|d| d.is_item_container())
    }
    fn floated(&self, id: NodeId, s: &ComputedValues) -> bool {
        use style::computed_values::position::T as Position;
        s.get_box().clone_float() != style::computed_values::float::T::None
            && !self.display(id, s).is_contents()
            && !matches!(s.get_box().clone_position(), Position::Absolute | Position::Fixed)
    }
    fn inline_level(&self, id: NodeId, s: &ComputedValues) -> bool {
        matches!(self.display(id, s).outside(), DisplayOutside::Inline)
    }
    // A non-atomic inline, which paints its own box in the inline phase of the context it sits in.
    fn paints_box_inline(&self, id: NodeId, s: &ComputedValues) -> bool {
        let d = self.display(id, s);
        matches!(d.outside(), DisplayOutside::Inline)
            && matches!(d.inside(), DisplayInside::Flow)
            && !self.arena.get(id).is_some_and(|n| crate::walk::replaced_or_control(self.arena, id, n))
    }
    fn z_index(&self, s: &ComputedValues) -> Option<i32> {
        match s.get_position().z_index {
            style::values::generics::position::GenericZIndex::Integer(z) => Some(z),
            style::values::generics::position::GenericZIndex::Auto => None,
        }
    }

    // Does the box establish a STACKING CONTEXT: `fixed` and `sticky` whatever their `z-index`, a positioned box or an
    // item with an integer one (or a `will-change: z-index`), a box that contains fixed descendants (a transform, a
    // filter, containment), one that composites its subtree as one image — or one with a current animation of a
    // property that would, even one still waiting out its delay.
    fn establishes(&self, id: NodeId, s: &ComputedValues) -> bool {
        use style::computed_values::position::T as Position;
        let Some(node) = self.arena.get(id) else { return false };
        let b = s.get_box();
        matches!(b.clone_position(), Position::Fixed | Position::Sticky)
            || ((self.positioned(s) || self.item(id, s)) && (self.z_index(s).is_some() || b.will_change.bits.contains(style::values::specified::box_::WillChangeBits::Z_INDEX)))
            || crate::walk::contains_out_of_flow(s, self.arena, id, node)
            || self.composites_as_group(id, s)
            || self.engine.is_some_and(|e| e.animation_activity(id, &self.stacking_animated).0)
    }
    // The effects that composite a subtree as ONE image before it meets the page: an opacity below 1, a blend mode, an
    // isolation, a clip path, a mask, a view-transition name, a transformable box that preserves 3D, and a `will-change`
    // naming one of them.
    fn composites_as_group(&self, id: NodeId, s: &ComputedValues) -> bool {
        use style::computed_values::isolation::T as Isolation;
        use style::computed_values::mix_blend_mode::T as MixBlendMode;
        use style::computed_values::transform_style::T as TransformStyle;
        use style_traits::ToCss;
        let b = s.get_box();
        let effects = s.get_effects();
        if effects.opacity < 1.0
            || effects.mix_blend_mode != MixBlendMode::Normal
            || b.isolation == Isolation::Isolate
            || !matches!(s.get_svg().clip_path, style::values::generics::basic_shape::GenericClipPath::None)
            || s.get_svg().mask_image.0.iter().any(|i| !matches!(i, style::values::computed::Image::None))
            || s.get_ui().view_transition_name != style::values::computed::ViewTransitionName::none()
        {
            return true;
        }
        if b.transform_style == TransformStyle::Preserve3d && !crate::geometry::non_replaced_inline(self.arena, id, s) {
            return true;
        }
        const GROUPING: [&str; 8] = ["opacity", "mix-blend-mode", "isolation", "clip-path", "mask", "mask-image", "view-transition-name", "transform-style"];
        let names = b.will_change.to_css_string();
        names.split(", ").any(|n| GROUPING.contains(&n))
    }
    // Is the box painted as ONE UNIT, as if it made a context, without making one: a positioned box of `z-index: auto`,
    // a float, an item, an atomic inline.
    fn paints_as_unit(&self, id: NodeId, s: &ComputedValues) -> bool {
        if self.establishes(id, s) {
            return false;
        }
        self.positioned(s) || self.floated(id, s) || self.item(id, s) || (self.inline_level(id, s) && !self.paints_box_inline(id, s))
    }
    // The PHASE a box paints in within its context.
    fn rank(&self, id: NodeId, s: &ComputedValues) -> f64 {
        let positioned = self.positioned(s);
        let item = !positioned && self.item(id, s);
        if positioned || item {
            // (`z-index: 0` and `auto` paint in the SAME layer, steps 8 / 9: tree order decides between them)
            if let Some(z) = self.z_index(s) {
                return if z == 0 { PAINT_POSITIONED } else { f64::from(z) };
            }
        }
        if positioned || self.establishes(id, s) {
            PAINT_POSITIONED
        } else if item || self.inline_level(id, s) {
            PAINT_INLINE
        } else if self.floated(id, s) {
            PAINT_FLOAT
        } else {
            PAINT_BLOCK
        }
    }

    // The levels ABOVE this box, each contributing its phase and its place in the tree: a context or a painting unit the
    // box is inside. A POSITIONED box (or one that makes a context) leaves the units, so a relative child of one
    // dropdown is not lifted over the dropdown declared after it; a box-less parent is no level of any kind.
    fn chain(&mut self, id: NodeId) -> Chain {
        if let Some(c) = self.chains.get(&id) {
            return c.clone();
        }
        let parent = flat_parent(self.arena, id).filter(|&p| self.arena.get(p).is_some_and(|n| n.kind == NodeKind::Element));
        let mut chain = Chain { key: Vec::new(), real: 0 };
        if let Some(parent) = parent {
            let up = self.chain(parent);
            chain = up.clone();
            if let Some(ps) = self.style(parent).filter(|_| !self.boxless(parent)) {
                if self.establishes(parent, &ps) {
                    chain.key.extend([self.rank(parent, &ps), self.order_of(parent)]);
                    chain.real = chain.key.len();
                } else if self.paints_as_unit(parent, &ps) {
                    chain.key.extend([self.rank(parent, &ps), self.order_of(parent)]);
                }
            }
            if chain.key.len() > chain.real && self.style(id).is_some_and(|s| self.positioned(&s) || self.establishes(id, &s)) {
                chain.key.truncate(chain.real);
            }
        }
        self.chains.insert(id, chain.clone());
        chain
    }
    // Where a LAYER sits in the painting order: a box, or the content it owns (`content`), which paints in the inline
    // phase of whatever the box paints inside — its own context or unit if it is one — just after the box itself.
    fn key(&mut self, id: NodeId, content: bool) -> Vec<f64> {
        let Some(s) = self.style(id) else { return Vec::new() };
        let mut key = self.chain(id).key;
        if !content || self.establishes(id, &s) || self.paints_as_unit(id, &s) {
            key.extend([self.rank(id, &s), self.order_of(id)]);
        }
        if content {
            key.extend([PAINT_INLINE, self.order_of(id), 0.0]);
        }
        key
    }

    // Of two layers, which paints ABOVE: their keys decide, except between a box and what is inside it
    // (`descendant_above`). Not transitive in every shape — a block inside an inline under a float is above the inline,
    // the inline above the float and the float above the block — so a sort by it is exact only where no such cycle
    // overlaps.
    fn above(&self, cand: (NodeId, bool), kc: &[f64], best: (NodeId, bool), kb: &[f64]) -> bool {
        if !cand.1 && !best.1 {
            if self.is_ancestor(best.0, cand.0) {
                return self.descendant_above(best.0, kb, kc);
            }
            if self.is_ancestor(cand.0, best.0) {
                return !self.descendant_above(cand.0, kc, kb);
            }
        }
        let n = kc.len().min(kb.len());
        let i = (0..n).find(|&i| kc[i] != kb[i]).unwrap_or(n);
        if i == n { kc.len() >= kb.len() } else { kc[i] > kb[i] }
    }
    // An element's own box never covers what is inside it, except content pushed behind it with a negative `z-index`,
    // the box being a block that is the context or unit the content belongs to — its background paints first — and a
    // FLOAT inside a non-atomic inline, whose fragments paint over the floats.
    fn descendant_above(&self, anc: NodeId, ka: &[f64], kd: &[f64]) -> bool {
        let n = ka.len().min(kd.len());
        let i = (0..n).find(|&i| ka[i] != kd[i]).unwrap_or(n);
        // (…a phase only where the keys part at a RANK, an even index: the ranks and orders alternate)
        let d = if i % 2 == 0 { kd.get(i).copied() } else { None };
        let inline_box = self.style(anc).is_some_and(|s| self.paints_box_inline(anc, &s));
        if i == ka.len() {
            return !(inline_box && d.is_some_and(|d| d < 0.0 || d == PAINT_FLOAT));
        }
        if d.is_some_and(|d| d < 0.0) {
            return false;
        }
        !(d == Some(PAINT_FLOAT) && ka[i] == PAINT_INLINE && inline_box)
    }
    fn is_ancestor(&self, a: NodeId, b: NodeId) -> bool {
        let mut p = flat_parent(self.arena, b);
        while let Some(at) = p {
            if at == a {
                return true;
            }
            p = flat_parent(self.arena, at);
        }
        false
    }

    // The painter's order of `layers` — each a box, or the content a box owns — bottom first.
    pub(crate) fn sort(&mut self, layers: &[(NodeId, bool)]) -> Vec<usize> {
        let keys: Vec<Vec<f64>> = layers.iter().map(|&(id, content)| self.key(id, content)).collect();
        let mut idx: Vec<usize> = (0..layers.len()).collect();
        merge_sort(&mut idx, &|&a: &usize, &b: &usize| self.above(layers[b], &keys[b], layers[a], &keys[a]));
        idx
    }

    // Every element a hit at the viewport point `(x, y)` lands on — laid out, not clipped away there, not
    // `pointer-events: none` or `visibility: hidden`, a box of it around the point — topmost first, a generated box
    // answering as its element; `all` false keeps the topmost alone. The root last, for the canvas it paints: the area
    // the root paints even where its box is shorter (Chrome: `elementFromPoint` below a 50px body is `<html>`).
    pub(crate) fn hit(&mut self, x: f64, y: f64, all: bool) -> Vec<NodeId> {
        let Some(root) = self.arena.layout_root else { return Vec::new() };
        let mut found: Vec<((NodeId, bool), Vec<f64>)> = Vec::new();
        if let Some(body) = self.body(root) {
            let at = self.preorder.iter().position(|&n| n == body);
            if let Some(at) = at {
                for k in at..self.ends[at] {
                    let id = self.preorder[k];
                    if !self.hits(id, x, y) {
                        continue;
                    }
                    let layer = (id, self.paints_replaced(id));
                    let key = self.key(id, layer.1);
                    if all {
                        found.push((layer, key));
                    } else if found.first().is_none_or(|(best, kb)| self.above(layer, &key, *best, kb)) {
                        found = vec![(layer, key)];
                    }
                }
            }
        }
        merge_sort(&mut found, &|a: &((NodeId, bool), Vec<f64>), b: &((NodeId, bool), Vec<f64>)| self.above(a.0, &a.1, b.0, &b.1));
        let mut out: Vec<NodeId> = Vec::new();
        for ((id, _), _) in found {
            let el = self.arena.get(id).and_then(|n| n.generated_of).map_or(id, |(origin, _)| origin);
            if !out.contains(&el) {
                out.push(el);
            }
        }
        // (…and inside an `<svg>` it lands on, the graphics element under the point, before it — with the containers it
        // is in — where there is one: the layout gives the `<svg>` alone a box)
        if let Some(i) = out.iter().position(|&id| self.arena.get(id).is_some_and(|n| n.ns == web_atoms::ns!(svg) && &*n.local_name == "svg")) {
            if let Some(shape) = crate::svg_geometry::hit(self.arena, out[i], x, y) {
                let mut inner = vec![shape];
                let mut at = self.arena.get(shape).and_then(|n| n.parent);
                while let Some(p) = at.filter(|&p| p != out[i]) {
                    inner.push(p);
                    at = self.arena.get(p).and_then(|n| n.parent);
                }
                if all {
                    out.splice(i..i, inner);
                } else {
                    out = vec![shape];
                }
            }
        }
        let [w, h] = self.arena.viewport;
        let in_viewport = x >= 0.0 && y >= 0.0 && x <= w && y <= h;
        // (…and where a modal dialog is shown, its `::backdrop` under it in the top layer, over the whole viewport and
        // answering as the dialog: what the rest of the document — inert, so hit nowhere — would have been; none where
        // the dialog is inert itself, or its backdrop generates no box. The root under it all: Chrome answers `html` for
        // `elementsFromPoint` past the backdrop, and for a point with no backdrop over it.)
        if let Some(modal) = self.arena.modals.iter().rev().copied().find(|&m| self.has_box(m)) {
            if in_viewport && !out.contains(&modal) && (all || out.is_empty()) && !self.arena.is_inert(modal) && self.has_backdrop(modal) {
                out.push(modal);
            }
        }
        if in_viewport && self.has_box(root) && !out.contains(&root) && (all || out.is_empty()) {
            out.push(root);
        }
        out
    }
    // Intersection Observer v2's "compute the visibility" of a target that tracks it: false where its effective
    // transformation matrix (unflattened: any z in it counts) is more than a 2D translation or a proportional upscaling,
    // where it or an element it is drawn through is translucent or filtered (the flat tree's ancestors that have a box,
    // whose opacity and filters it is drawn under), or where anything may be painted over it (`overlapped`).
    pub(crate) fn visible(&mut self, target: NodeId) -> bool {
        if let Some(m) = crate::geometry::unflattened_chain(self.arena, target) {
            let planar = [m[2], m[3], m[6], m[7], m[8], m[9], m[11], m[14]].iter().all(|&v| v == 0.0) && m[10] == 1.0 && m[15] == 1.0;
            if !(planar && m[1] == 0.0 && m[4] == 0.0 && m[0] == m[5] && m[0] >= 1.0) {
                return false;
            }
        }
        let mut at = Some(target);
        while let Some(n) = at.filter(|&n| self.arena.get(n).is_some_and(|d| d.kind == NodeKind::Element)) {
            if self.drawn_through(n).is_some_and(|s| s.get_effects().opacity < 1.0 || !s.get_effects().filter.0.is_empty()) {
                return false;
            }
            at = flat_parent(self.arena, n);
        }
        !self.overlapped(target)
    }
    // The style of `n` where it is a box something is drawn through — a box-less one's opacity and filters apply to
    // nothing (Chrome: a target under a `display: contents; opacity: .5` element is visible).
    fn drawn_through(&self, n: NodeId) -> Option<style::servo_arc::Arc<ComputedValues>> {
        self.style(n).filter(|s| !crate::geometry::is_boxless(self.arena, n, s))
    }
    // Whether anything painted over `target` may cover any part of its box — Intersection Observer v2's "cannot
    // guarantee that the target is completely unoccluded", answered conservatively: some box — visible, not drawn wholly
    // transparent, as the clips above it leave it (one under a transform kept whole), neither `target`'s own content nor
    // an ancestor it is drawn on — that overlaps its rendered box and paints above it. A box with no ink counts too, as
    // it may (Chrome measures ink); ink outside a box — overflowing text — is not seen. True where it has no box.
    pub(crate) fn overlapped(&mut self, target: NodeId) -> bool {
        let Some([tx, ty, tw, th]) = crate::geometry::rendered_box(self.arena, target) else { return true };
        // (…the root at 0, whatever order the painting gives it)
        let Some(at) = self.preorder.iter().position(|&n| n == target) else { return true };
        let tkey = self.key(target, false);
        for k in 0..self.preorder.len() {
            // (…its own subtree, and the boxes whose subtree it is in)
            if (at..self.ends[at]).contains(&k) || (k < at && at < self.ends[k]) {
                continue;
            }
            let id = self.preorder[k];
            let Some([x0, y0, x1, y1]) = self.painted_rect(id) else { continue };
            if x0 >= tx + tw || x1 <= tx || y0 >= ty + th || y1 <= ty {
                continue;
            }
            let Some(s) = self.style(id) else { continue };
            if s.get_inherited_box().visibility != style::computed_values::visibility::T::Visible || self.transparent(id) {
                continue;
            }
            let key = self.key(id, false);
            if self.above((id, false), &key, (target, false), &tkey) {
                return true;
            }
        }
        false
    }
    // A box's rendered rect as the clips above it leave it, `[x0, y0, x1, y1]` — None where they leave nothing — once
    // per painting, however many targets ask.
    fn painted_rect(&mut self, id: NodeId) -> Option<[f64; 4]> {
        if let Some(&r) = self.painted.get(&id) {
            return r;
        }
        let r = crate::geometry::rendered_box(self.arena, id).and_then(|[x, y, w, h]| {
            let [mut x0, mut y0, mut x1, mut y1] = [x, y, x + w, y + h];
            for c in crate::geometry::clip_boxes(self.arena, id, false) {
                if c[4..10] != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
                    continue;
                }
                [x0, y0, x1, y1] = [x0.max(c[0]), y0.max(c[1]), x1.min(c[0] + c[2]), y1.min(c[1] + c[3])];
            }
            (x1 > x0 && y1 > y0).then_some([x0, y0, x1, y1])
        });
        self.painted.insert(id, r);
        r
    }
    // …nothing of `id` drawn at all: it, or a box it is drawn through, at opacity 0.
    fn transparent(&self, id: NodeId) -> bool {
        let mut at = Some(id);
        while let Some(n) = at.filter(|&n| self.arena.get(n).is_some_and(|d| d.kind == NodeKind::Element || d.generated_of.is_some())) {
            if self.drawn_through(n).is_some_and(|s| s.get_effects().opacity == 0.0) {
                return true;
            }
            at = flat_parent(self.arena, n);
        }
        false
    }
    // The document's BODY: the root's first `<body>` or `<frameset>` child.
    fn body(&self, root: NodeId) -> Option<NodeId> {
        self.arena.get(root)?.children.iter().copied().find(|&c| self.arena.get(c).is_some_and(|n| n.is_html_named("body") || n.is_html_named("frameset")))
    }
    // An element that paints REPLACED content over its box — an image, a canvas, a video, a nested browsing context, a
    // `<select>`'s face — which appendix E paints with the lines. (A button's or an input's is text, which is not
    // hit-tested.)
    fn paints_replaced(&self, id: NodeId) -> bool {
        self.arena.get(id).is_some_and(|n| matches!(n.rendering_tag(), "img" | "canvas" | "video" | "iframe" | "embed" | "object" | "select"))
    }
    fn hits(&self, id: NodeId, x: f64, y: f64) -> bool {
        let Some(s) = self.style(id) else { return false };
        if s.get_inherited_ui().pointer_events == style::computed_values::pointer_events::T::None {
            return false;
        }
        if s.get_inherited_box().visibility != style::computed_values::visibility::T::Visible {
            return false;
        }
        // (…and not inert: as if absent to a hit, HTML §6.6.2 — asked of a box around the point alone)
        contains_point(self.arena, id, x, y) && !clipped_at(self.arena, id, x, y) && !self.arena.is_inert(id)
    }
}

// A stable MERGE SORT by `before(a, b)` — whether `a` goes before `b` — which a sort of the painting order needs: that
// order is not transitive in every shape (`Painting::above`), and the standard library's sorts may panic on a
// comparison that is not a total order. Where there is a cycle the order is the merges', deterministically.
fn merge_sort<T: Clone>(items: &mut [T], before: &dyn Fn(&T, &T) -> bool) {
    if items.len() < 2 {
        return;
    }
    let mid = items.len() / 2;
    merge_sort(&mut items[..mid], before);
    merge_sort(&mut items[mid..], before);
    let (left, right) = (items[..mid].to_vec(), items[mid..].to_vec());
    let (mut i, mut j) = (0, 0);
    for slot in items.iter_mut() {
        // (…the right one first only where it goes BEFORE the left: stable)
        if j < right.len() && (i == left.len() || before(&right[j], &left[i])) {
            *slot = right[j].clone();
            j += 1;
        } else {
            *slot = left[i].clone();
            i += 1;
        }
    }
}

// The point `(x, y)` carried back through `id`'s transform chain onto the plane its box was laid out in — None where the
// chain is degenerate, or the point's preimage lies on or BEHIND the projection plane (a `perspective(200px)
// translateZ(250px)` box has negative `w` everywhere, and a browser hits it nowhere).
fn untransformed(arena: &RealmArena, id: NodeId, x: f64, y: f64) -> Option<[f64; 2]> {
    let Some(m) = transform_chain(arena, id) else { return Some([x, y]) };
    let inverse = invert_homography(&m)?;
    let [px, py] = apply_homography(&inverse, x, y)?;
    (m[3] * px + m[7] * py + m[15] > 0.0).then_some([px, py])
}
fn invert_homography(m: &M4) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, i, j] = [m[0], m[1], m[3], m[4], m[5], m[7], m[12], m[13], m[15]];
    let (aa, bb, cc) = (e * j - f * i, -(b * j - c * i), b * f - c * e);
    let det = a * aa + d * bb + g * cc;
    if det == 0.0 {
        return None;
    }
    Some([
        aa / det, bb / det, cc / det,
        -(d * j - f * g) / det, (a * j - c * g) / det, -(a * f - c * d) / det,
        (d * i - e * g) / det, -(a * i - b * g) / det, (a * e - b * d) / det,
    ])
}
fn apply_homography(h: &[f64; 9], x: f64, y: f64) -> Option<[f64; 2]> {
    let w = h[2] * x + h[5] * y + h[8];
    (w != 0.0).then(|| [(h[0] * x + h[3] * y + h[6]) / w, (h[1] * x + h[4] * y + h[7]) / w])
}

// Is the viewport point inside what `id` paints — its box, or a FRAGMENTED inline's pieces (not their union, which
// would cover the end of one line and the start of the next)? Half-open, as a browser hit-tests: the near edges belong
// to the box, the far ones to whatever is behind it (Chrome: (99.9, 25) is in a 100x50 box at the origin, (100, 25) not).
fn contains_point(arena: &RealmArena, id: NodeId, x: f64, y: f64) -> bool {
    let Some([px, py]) = untransformed(arena, id, x, y) else { return false };
    let Some(node) = arena.get(id) else { return false };
    let covers = |[bx, by, bw, bh]: [f64; 4]| px >= bx && px < bx + bw && py >= by && py < by + bh;
    match laid_frags(arena, node) {
        Some(frags) => {
            let [sx, sy] = crate::geometry::scroll_shift(arena, id);
            frags.iter().any(|&[fx, fy, fw, fh]| covers([fx - sx, fy - sy, fw, fh]))
        }
        None => laid_out_box(arena, id).is_some_and(covers),
    }
}

// Is the viewport point CLIPPED AWAY from `id` by a box whose overflow clips it: one in `id`'s containing-block chain —
// its parent box for a box in flow, the box it was placed against for an out-of-flow one, which escapes every clip in
// between (a `fixed` one placed against the viewport escapes them all) — that does not reach the point in an axis it
// clips, at its padding edge?
fn clipped_at(arena: &RealmArena, id: NodeId, x: f64, y: f64) -> bool {
    use crate::layout::{CLIP_X, CLIP_Y};
    let mut at = id;
    loop {
        let Some(node) = arena.get(at) else { return false };
        let next = match laid(arena, node) {
            Some(b) if b.out_of_flow != 0 => node.containing_block,
            _ => box_parent(arena, at),
        };
        let Some(next) = next else { return false };
        // (…an inline box, which an out-of-flow one may be placed against, clips nothing: `overflow` does not apply)
        let Some(nb) = arena.get(next).and_then(|n| laid(arena, n)) else {
            at = next;
            continue;
        };
        let clip = nb.clip & (CLIP_X | CLIP_Y);
        if clip != 0 {
            let Some([px, py]) = untransformed(arena, next, x, y) else { return true };
            let Some([bx, by, bw, bh]) = laid_out_box(arena, next) else { return false };
            let e = nb.edges.unwrap_or([0.0; 12]);
            let [left, top] = [bx + e[7], by + e[4]];
            let [right, bottom] = [bx + bw - e[5], by + bh - e[6]];
            if clip & CLIP_X != 0 && (px < left || px >= right) {
                return true;
            }
            if clip & CLIP_Y != 0 && (py < top || py >= bottom) {
                return true;
            }
        }
        at = next;
    }
}
// Is `id`'s rendered box CLIPPED AWAY whole — outside the padding box of a box that clips it (in its containing-block
// chain, as `clipped_at` reads it), in an axis that box clips? What `isObscured` and an intersection observation ask
// before they ask of a point.
pub(crate) fn clipped_away(arena: &RealmArena, id: NodeId) -> bool {
    use crate::layout::{CLIP_X, CLIP_Y};
    let Some([ex, ey, ew, eh]) = crate::geometry::rendered_box(arena, id) else { return false };
    let mut at = id;
    loop {
        let Some(node) = arena.get(at) else { return false };
        let next = match laid(arena, node) {
            Some(b) if b.out_of_flow != 0 => node.containing_block,
            _ => box_parent(arena, at),
        };
        let Some(next) = next else { return false };
        let Some(nb) = arena.get(next).and_then(|n| laid(arena, n)) else {
            at = next;
            continue;
        };
        let clip = nb.clip & (CLIP_X | CLIP_Y);
        if clip != 0 {
            let Some([bx, by, bw, bh]) = laid_out_box(arena, next) else { return false };
            let e = nb.edges.unwrap_or([0.0; 12]);
            let padding = [bx + e[7], by + e[4], (bw - e[7] - e[5]).max(0.0), (bh - e[4] - e[6]).max(0.0)];
            let [px, py, pw, ph] = match transform_chain(arena, next) {
                Some(m) => crate::geometry::transformed_rect(&m, padding),
                None => padding,
            };
            if clip & CLIP_X != 0 && (ex + ew <= px || ex >= px + pw) {
                return true;
            }
            if clip & CLIP_Y != 0 && (ey + eh <= py || ey >= py + ph) {
                return true;
            }
        }
        at = next;
    }
}

// The nearest flat-tree ancestor that holds a box of the current layout — an inline box's fragments included where
// `box_parent_or_inline` asks.
pub(crate) fn box_parent_or_inline(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let mut p = flat_parent(arena, id);
    while let Some(at) = p {
        let n = arena.get(at)?;
        if n.kind != NodeKind::Element {
            return None;
        }
        if laid(arena, n).is_some() || laid_frags(arena, n).is_some() {
            return Some(at);
        }
        p = flat_parent(arena, at);
    }
    None
}
// The nearest flat-tree ancestor that holds a box of the current layout.
pub(crate) fn box_parent(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let mut p = flat_parent(arena, id);
    while let Some(at) = p {
        let n = arena.get(at)?;
        if n.kind != NodeKind::Element {
            return None;
        }
        if laid(arena, n).is_some() {
            return Some(at);
        }
        p = flat_parent(arena, at);
    }
    None
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "isInert", is_inert_op, context_id);
    crate::dom::register(scope, ns, "hitTest", hit_test_op, context_id);
    crate::dom::register(scope, ns, "paintOrder", paint_order_op, context_id);
    crate::dom::register(scope, ns, "observedVisible", observed_visible_op, context_id);
    crate::dom::register(scope, ns, "clippedAway", clipped_away_op, context_id);
}

// __dom.clippedAway(nid) -> whether the element's rendered box is clipped away whole (`clipped_away`).
// __dom.isInert(nid) -> whether the node is inert (`RealmArena::is_inert`): the driver refuses to click it.
fn is_inert_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let inert = crate::dom::nid_arg(scope, &args, 0).is_some_and(|id| crate::dom::realm(scope, cid).is_inert(id));
    rv.set_bool(inert);
}
fn clipped_away_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let away = crate::dom::nid_arg(scope, &args, 0).is_some_and(|id| clipped_away(crate::dom::realm(scope, cid), id));
    rv.set(v8::Boolean::new(scope, away).into());
}

// One painting question asked with the realm's arena and its style engine's animations at the page's clock `now`.
fn painting<R>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, now_at: i32, ask: impl FnOnce(&mut Painting<'_>) -> R) -> Option<R> {
    let cid = crate::dom::realm_id(scope, args);
    let now = args.get(now_at).number_value(scope).filter(|n| n.is_finite());
    let d = crate::dom::dom(scope);
    let arena = d.arena.enter_known(cid)?;
    let engine = d.styles.get_mut(&cid);
    let engine = engine.map(|engine| {
        if let Some(now) = now.filter(|&n| engine.web_animations.timeline_time != Some(n)) {
            engine.web_animations_op(|model| model.set_timeline_time(now));
        }
        &*engine
    });
    Some(ask(&mut Painting::new(arena, engine)))
}

// __dom.hitTest(x, y, all, now) -> Float64Array: the elements a hit at the viewport point lands on, topmost first (only
// the topmost unless `all`), as `nodes_value` answers them from the document (`Painting::hit`).
fn hit_test_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let x = args.get(0).number_value(scope).unwrap_or(f64::NAN);
    let y = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let all = args.get(2).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let Some(hits) = painting(scope, &args, 3, |p| p.hit(x, y, all)) else { return };
    let arena = crate::dom::realm(scope, cid);
    let Some(document) = hits.first().map(|&id| arena.shadow_including_root(id)) else { return rv.set(crate::dom::f64_array(scope, &[]).into()) };
    let answer = crate::dom::nodes_value(scope, cid, document, &hits);
    rv.set(answer);
}

// __dom.paintOrder(nids, contents, now) -> Float64Array: the indices of the layers `nids` names — each a box, or where
// `contents[i]` is 1 the content that box owns — in the order they paint, bottom first (`Painting::sort`).
fn paint_order_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let nids = crate::dom::f64_arg(args.get(0)).to_vec();
    let contents = crate::dom::f64_arg(args.get(1)).to_vec();
    let layers: Vec<(NodeId, bool)> = nids
        .iter()
        .zip(&contents)
        .map(|(&n, &c)| (NodeId::from_i64(n as i64).unwrap_or(NodeId { idx: u32::MAX, generation: 0 }), c != 0.0))
        .collect();
    let Some(order) = painting(scope, &args, 2, |p| p.sort(&layers)) else { return };
    let order: Vec<f64> = order.into_iter().map(|i| i as f64).collect();
    rv.set(crate::dom::f64_array(scope, &order).into());
}

// __dom.observedVisible(nids, now) -> Float64Array: for each element `nids` names, 1 where an intersection observer
// tracking visibility sees it visible, else 0 (`Painting::visible`) — one painting for all of them.
fn observed_visible_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let nids = crate::dom::f64_arg(args.get(0)).to_vec();
    let ids: Vec<Option<NodeId>> = nids.iter().map(|&n| NodeId::from_i64(n as i64).filter(|_| n >= 0.0)).collect();
    let answers = painting(scope, &args, 1, |p| ids.iter().map(|id| f64::from(u8::from(id.is_some_and(|id| p.visible(id))))).collect::<Vec<f64>>())
        .unwrap_or_else(|| vec![0.0; ids.len()]);
    rv.set(crate::dom::f64_array(scope, &answers).into());
}
