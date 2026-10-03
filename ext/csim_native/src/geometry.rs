// The page-visible GEOMETRY of the last layout: what the boxes it left on the nodes (`NodeData::layout_box`) come to
// once the scroll offsets the page has moved since (`NodeData::scroll`) carry them — read by the geometry API
// (`getBoundingClientRect`, the hit test, `scrollIntoView`) through the ops at the end of this file.
//
// A box is placed in DOCUMENT coordinates by the layout; scrolling moves no box, it moves what the viewport shows of
// it. So the scroll shift is a paint-time offset taken here, at read time — as is a `position: sticky` box's, which
// the layout places in flow like any other and which sticks only as the page scrolls past it.

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::layout::{Box, CB_RECT, CLIP_SCROLLS, OOF_FIXED, POSITION_STICKY};
use crate::walk::WalkDisplay;
use style::servo_arc::Arc;
use style::properties::ComputedValues;
use style::values::computed::Length;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

// A node's parent in the FLAT tree (`flatTreeParent`, the style engine's `traversal_parent`): a slotted node's slot, a
// shadow tree's top-level node's host — none for a host's child no slot takes — and a generated box's element.
pub(crate) fn flat_parent(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let node = arena.get(id)?;
    if let Some((origin, _)) = node.generated_of {
        return Some(origin);
    }
    let p = node.parent?;
    let pn = arena.get(p)?;
    if pn.shadow_root.is_some() {
        return node.assigned_slot.filter(|&s| arena.get(s).is_some());
    }
    match pn.host {
        Some(host) if pn.kind != NodeKind::Element => Some(host),
        _ => Some(p),
    }
}

// …and its children there (the style engine's `traversal_children`): a host's are its shadow root's, a slot its assigned
// nodes where it has any, anything else its own.
pub(crate) fn flat_children<'a>(arena: &'a RealmArena, node: &'a crate::dom::NodeData) -> &'a [NodeId] {
    match node.shadow_root.and_then(|r| arena.get(r)) {
        Some(root) => &root.children,
        None if !node.assigned.is_empty() => &node.assigned,
        None => &node.children,
    }
}

// The style a box was laid out with: an element's, or a generated box's — its element's `::before` / `::after`.
pub(crate) fn box_style(arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
    match arena.get(id)?.generated_of {
        Some((origin, which)) => crate::style::eager_pseudo(arena, origin, &crate::walk::PSEUDOS[which as usize]),
        None => crate::style::primary_style(arena, id),
    }
}

// The box `node` holds from the CURRENT layout — what an earlier one left is no box of this one — and the fragments.
pub(crate) fn laid<'a>(arena: &RealmArena, node: &'a crate::dom::NodeData) -> Option<&'a Box> {
    node.layout_box.as_ref().filter(|_| node.laid_at == arena.layout_pass)
}
pub(crate) fn laid_frags<'a>(arena: &RealmArena, node: &'a crate::dom::NodeData) -> Option<&'a [[f64; 4]]> {
    node.layout_frags.as_deref().filter(|_| node.laid_at == arena.layout_pass)
}

// What the geometry reads keep between two changes to anything they read (`RealmArena::geometry_epoch`: a layout pass,
// a scroll, a restyle, a tree change): each node's transform chain and the scroll shift of the boxes it holds. A rect
// read and every candidate of a hit test ask them, and each walks every ancestor's style without one.
// (…the extents, which no scroll offset enters, against `boxes_epoch`: a virtual list reading its scroll height after
// every scroll would walk its whole subtree again for each.)
#[derive(Default)]
pub(crate) struct Memo {
    epoch: u64,
    chains: std::collections::HashMap<NodeId, Option<M4>>,
    below: std::collections::HashMap<NodeId, [f64; 2]>,
    boxes_epoch: u64,
    extents: std::collections::HashMap<NodeId, Extent>,
}
fn memo(arena: &RealmArena) -> std::cell::RefMut<'_, Memo> {
    let mut memo = arena.geometry_memo.borrow_mut();
    let epoch = arena.geometry_epoch.get();
    if memo.epoch != epoch {
        memo.epoch = epoch;
        memo.chains.clear();
        memo.below.clear();
    }
    let boxes_epoch = arena.boxes_epoch.get();
    if memo.boxes_epoch != boxes_epoch {
        memo.boxes_epoch = boxes_epoch;
        memo.extents.clear();
    }
    memo
}

// Is this the box of a `position: fixed` element laid out against the VIEWPORT — which no scrolling moves?
fn is_fixed(b: &Box) -> bool {
    b.out_of_flow == OOF_FIXED && b.cb == CB_RECT
}

// The total scroll shift the page has carried `id`'s box by, `[x, y]`: the document's scroll, and every scroll
// container's around it, compounding up — less the distance a STICKY box among them (it included) has stuck. With
// `below`, the shift of a box `id` holds rather than of `id`'s own: an anonymous box, which no node names.
pub(crate) fn scroll_shift(arena: &RealmArena, id: NodeId, below: bool) -> [f64; 2] {
    if below {
        return shift_below(arena, id);
    }
    let Some(node) = arena.get(id) else { return [0.0; 2] };
    // A `position: fixed` box is laid out against the VIEWPORT, so no scrolling moves it — that is what fixed means, and
    // how a pinned header stays put while the page scrolls under it.
    if laid(arena, node).is_some_and(is_fixed) {
        return [0.0; 2];
    }
    // The document's scroll moves the ROOT ELEMENT's own box, not just its descendants': `html`'s client rect sits at
    // `(-scrollX, -scrollY)` in every browser (Floating UI reads its scrollbar offset as `left + scrollLeft`).
    if Some(id) == arena.layout_root {
        return node.scroll;
    }
    let mut shift = flat_parent(arena, id).map_or([0.0; 2], |p| shift_below(arena, p));
    unstick(&mut shift, sticky_delta(arena, id));
    shift
}
// …the shift of the boxes `p` holds: its own scroll where it is the root or a scroll container, less what it has stuck
// if it is sticky, and its ancestors' — none past a FIXED one, whose own scroll still moves its content.
fn shift_below(arena: &RealmArena, p: NodeId) -> [f64; 2] {
    if let Some(&shift) = memo(arena).below.get(&p) {
        return shift;
    }
    let Some(pn) = arena.get(p) else { return [0.0; 2] };
    let b = laid(arena, pn);
    let mut shift = if b.is_some_and(is_fixed) { [0.0; 2] } else { flat_parent(arena, p).map_or([0.0; 2], |up| shift_below(arena, up)) };
    if Some(p) == arena.layout_root || b.is_some_and(|b| b.clip & CLIP_SCROLLS != 0) {
        shift[0] += pn.scroll[0];
        shift[1] += pn.scroll[1];
    }
    unstick(&mut shift, sticky_delta(arena, p));
    memo(arena).below.insert(p, shift);
    shift
}
fn unstick(shift: &mut [f64; 2], delta: Option<[f64; 2]>) {
    if let Some([dx, dy]) = delta {
        shift[0] -= dx;
        shift[1] -= dy;
    }
}

// How far a `position: sticky` box has STUCK, `[dx, dy]` — None for any other box, or one not moved. It is laid out
// in flow like any other box; it scrolls with its container until it reaches the offset its insets give it inside the
// nearest SCROLLPORT, then stays there while the content scrolls on under it, as far as the end of its containing
// block, which pushes it back out (css-position-3 §3.4). Without it a sticky sidebar scrolled off the top of the
// viewport with the page, and a sticky header stopped covering what it covers.
fn sticky_delta(arena: &RealmArena, id: NodeId) -> Option<[f64; 2]> {
    let b = laid(arena, arena.get(id)?).filter(|b| b.position == POSITION_STICKY)?;
    let cb = containing_rect(arena, sticky_containing_block(arena, id)?)?;
    let port = scrollport(arena, id)?;
    let style = box_style(arena, id)?;
    let pos = style.get_position();
    let inset = |v, basis: f64| {
        crate::walk::inset_lp(v).ok().flatten().map(|lp| f64::from(lp.resolve(Length::new(basis as f32)).px()))
    };
    let (top, bottom) = (inset(&pos.top, port[3]), inset(&pos.bottom, port[3]));
    let (left, right) = (inset(&pos.left, port[2]), inset(&pos.right, port[2]));
    let [mut dx, mut dy] = [0.0f64; 2];
    // (…a far-side inset pulls the box back only where it moves it at all: the near side's offset otherwise stands)
    let pull = |d: f64, to: f64| match d.min(to) {
        m if m != 0.0 && !m.is_nan() => m,
        _ => d,
    };
    if let Some(top) = top {
        dy = dy.max(port[1] + top - b.y);
    }
    if let Some(bottom) = bottom {
        dy = pull(dy, port[1] + port[3] - bottom - b.h - b.y);
    }
    if let Some(left) = left {
        dx = dx.max(port[0] + left - b.x);
    }
    if let Some(right) = right {
        dx = pull(dx, port[0] + port[2] - right - b.w - b.x);
    }
    // …never past its containing block: a sticky box leaves with it rather than outliving it — and only in an axis it
    // has an inset in, since an axis with none never moves (§3.4: clamping an unmoved axis against the block SHIFTED a
    // box whose static position overflowed it).
    if top.is_some() || bottom.is_some() {
        dy = dy.min(cb[1] + cb[3] - (b.y + b.h)).max(cb[1] - b.y);
    }
    if left.is_some() || right.is_some() {
        dx = dx.min(cb[0] + cb[2] - (b.x + b.w)).max(cb[0] - b.x);
    }
    (dx != 0.0 || dy != 0.0).then_some([dx, dy])
}

// A sticky box's containing block: its nearest BLOCK CONTAINER — past a box-less ancestor, past the table parts it sits
// in (a sticky `<th>` holds for the whole TABLE in a browser, not just its row), and past the inline boxes it sits in.
fn sticky_containing_block(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let display = |at: NodeId| {
        let node = arena.get(at)?;
        Some(box_style(arena, at)?.get_box().walk_display(node.rendering_tag()))
    };
    let mut at = flat_parent(arena, id)?;
    while display(at)?.is_contents() {
        at = flat_parent(arena, at)?;
    }
    while matches!(display(at)?.outside(), DisplayOutside::InternalTable) {
        at = flat_parent(arena, at)?;
    }
    while display(at).is_some_and(|d| matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)) {
        at = flat_parent(arena, at)?;
    }
    Some(at)
}

// The rect a sticky box may not leave, its containing block's content box — all of it a SCROLL CONTAINER scrolls
// through, where it is one: a sticky child of a scroller sticks for as long as the scroller has content to scroll
// (Chrome and Firefox: stuck 5px into a 200px scroller scrolled 250px down, where the content box alone let it go).
fn containing_rect(arena: &RealmArena, cb: NodeId) -> Option<[f64; 4]> {
    let node = arena.get(cb)?;
    let b = laid(arena, node)?;
    let mut rect = content_box(b);
    if b.clip & CLIP_SCROLLS != 0 {
        let [mut right, mut bottom] = [rect[0] + rect[2], rect[1] + rect[3]];
        for c in flat_children(arena, node).iter().chain(node.pseudo_boxes.iter().flatten()) {
            let Some(cb) = arena.get(*c).and_then(|n| laid(arena, n)) else { continue };
            let m = cb.edges.map_or([0.0; 4], |e| [e[8], e[9], e[10], e[11]]);
            right = right.max(cb.x + cb.w + m[1]);
            bottom = bottom.max(cb.y + cb.h + m[2]);
        }
        rect[2] = right - rect[0];
        rect[3] = bottom - rect[1];
    }
    Some(rect)
}

// The SCROLLPORT a sticky box sticks within, `[x, y, width, height]` in the document coordinates the boxes are in: its
// nearest scroll container's padding box inset by its padding (Chrome pins a sticky child of a `border: 10px; padding:
// 20px` scroller 30px in), or the viewport — each from where its own scroll has moved it to.
fn scrollport(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let root = arena.layout_root;
    let mut at = flat_parent(arena, id);
    while let Some(p) = at {
        let pn = arena.get(p)?;
        if Some(p) == root {
            let [w, h] = arena.viewport;
            return Some([pn.scroll[0], pn.scroll[1], w, h]);
        }
        if let Some(b) = laid(arena, pn).filter(|b| b.clip & CLIP_SCROLLS != 0) {
            let [x, y, w, h] = content_box(b);
            return Some([x + pn.scroll[0], y + pn.scroll[1], w, h]);
        }
        at = flat_parent(arena, p);
    }
    None
}

// A box's CONTENT box, `[x, y, width, height]`: its border box less the borders and padding the pass laid it out with.
fn content_box(b: &Box) -> [f64; 4] {
    let e = b.edges.unwrap_or([0.0; 12]);
    let [top, right, bottom, left] = [e[0] + e[4], e[1] + e[5], e[2] + e[6], e[3] + e[7]];
    [b.x + left, b.y + top, (b.w - left - right).max(0.0), (b.h - top - bottom).max(0.0)]
}

// What a pass laid out BESIDES the records' boxes (`laid_answer` stores those): each INLINE box's fragments, off its
// fragment rows `[inline index, x, y, w, h]` and the node each inline entry is (`inline_nids`), stored on the node in
// place of a box (`NodeData::layout_frags`) — and each out-of-flow box's containing block, which its record names by
// its own index (`NodeData::containing_block`).
pub(crate) fn store_layout(arena: &mut RealmArena, laid: &crate::layout::Laid, inline_nids: &[f64], anon: &[[f64; 4]]) {
    let pass = arena.layout_pass;
    let nid = |v: f64| NodeId::from_i64(v as i64).filter(|_| v >= 0.0);
    let mut by_inline: Vec<Vec<[f64; 4]>> = vec![Vec::new(); inline_nids.len()];
    for &[at, x, y, w, h] in &laid.frags {
        if let Some(list) = by_inline.get_mut(at as usize) {
            list.push([x, y, w, h]);
        }
    }
    for (at, frags) in inline_nids.iter().zip(by_inline) {
        let Some(node) = nid(*at).and_then(|id| arena.get_mut_quietly(id)) else { continue };
        if frags.is_empty() {
            continue;
        }
        node.layout_box = None;
        node.layout_frags = Some(frags.into_boxed_slice());
        node.laid_at = pass;
    }
    for b in &laid.boxes {
        let cb = match b.cb {
            _ if b.out_of_flow == 0 => None,
            at if at >= 0 => laid.boxes.get(at as usize).and_then(|c| nid(c.nid)),
            crate::layout::CB_INLINE => inline_nids.get(b.cb_inline as usize).and_then(|&v| nid(v)),
            _ => None,
        };
        if let Some(node) = nid(b.nid).and_then(|id| arena.get_mut_quietly(id)) {
            node.containing_block = cb;
            node.anon_boxes = None;
        }
    }
    let mut anon_of: std::collections::HashMap<NodeId, Vec<[f64; 4]>> = std::collections::HashMap::new();
    for &[record, _, container, _] in anon {
        if let (Some(b), Some(container)) = (laid.boxes.get(record as usize), nid(container)) {
            anon_of.entry(container).or_default().push([b.x, b.y, b.w, b.h]);
        }
    }
    for (container, boxes) in anon_of {
        if let Some(node) = arena.get_mut_quietly(container) {
            node.anon_boxes = Some(boxes.into_boxed_slice());
        }
    }
}

// The box the last layout placed `id` in, `[x, y, w, h]` in document coordinates: its record's border box, or the union
// of an inline box's fragments.
pub(crate) fn placed_box(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let node = arena.get(id)?;
    if let Some(b) = laid(arena, node) {
        return Some([b.x, b.y, b.w, b.h]);
    }
    let frags = laid_frags(arena, node)?;
    let [mut x0, mut y0, mut x1, mut y1] = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for &[x, y, w, h] in frags {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + w);
        y1 = y1.max(y + h);
    }
    Some([x0, y0, x1 - x0, y1 - y0])
}

// …and where the page's scrolling has carried it to (`laidOutBox`): in VIEWPORT coordinates, untransformed.
pub(crate) fn laid_out_box(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let [x, y, w, h] = placed_box(arena, id)?;
    let [sx, sy] = scroll_shift(arena, id, false);
    Some([x - sx, y - sy, w, h])
}

// ── transforms ─────────────────────────────────────────────────────────────────────────────────────────────────
// A transform does not move the element in FLOW, but it moves the box the page can MEASURE: a client rect and a hit
// test see the transformed quad. The map from an element's own coordinates to the viewport is its transform taken
// ABOUT ITS ORIGIN, then every transformed ancestor's, outermost last — crossing into each parent as css-transforms-2
// orders it: the parent's `perspective`, then a FLATTEN unless the parent shares its 3D rendering context. 4x4s in
// CSS `matrix3d()` order (column-major), as the style engine composes them.
pub(crate) type M4 = [f64; 16];

pub(crate) fn multiply(a: &M4, b: &M4) -> M4 {
    let mut out = [0.0; 16];
    for c in 0..4 {
        for r in 0..4 {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    out
}
fn translate([x, y, z]: [f64; 3]) -> M4 {
    [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0]
}
// `m` taken about `origin`: `translate(origin) · m · translate(-origin)`.
fn about(origin: [f64; 3], m: &M4) -> M4 {
    multiply(&translate(origin), &multiply(m, &translate(origin.map(|v| -v))))
}
// A 3D map FLATTENED onto the plane it lands in (css-transforms-2 §6): no z in, none out.
fn flatten(m: &M4) -> M4 {
    let mut out = *m;
    for i in [2, 6, 8, 9, 11, 14] {
        out[i] = 0.0;
    }
    out[10] = 1.0;
    out
}

// The map from `id`'s box to the viewport (`transformChain`), None where nothing on the way transforms it: its own step,
// then each ancestor's after crossing into it — and the chain an ancestor maps ITS box by, taken whole, from the first
// crossing that FLATTENS (or that carries no map at all): `flatten(A · B)` is `flatten(A) · B` only where B is flat,
// so across a `preserve-3d` boundary the steps are composed one by one.
pub(crate) fn transform_chain(arena: &RealmArena, id: NodeId) -> Option<M4> {
    if let Some(&chain) = memo(arena).chains.get(&id) {
        return chain;
    }
    let mut m = transform_step(arena, id);
    let mut at = id;
    let chain = loop {
        let Some(up) = flat_parent(arena, at).filter(|&n| arena.get(n).is_some_and(|n| n.kind == NodeKind::Element)) else { break m };
        if m.is_none() || !shares_context(arena, up) {
            let crossed = cross_into(arena, up, m);
            break match (transform_chain(arena, up), crossed) {
                (Some(outer), Some(inner)) => Some(multiply(&outer, &inner)),
                (outer, inner) => outer.or(inner),
            };
        }
        let crossed = cross_into(arena, up, m);
        m = match (transform_step(arena, up), crossed) {
            (Some(t), Some(inner)) => Some(multiply(&t, &inner)),
            (t, inner) => t.or(inner),
        };
        at = up;
    };
    memo(arena).chains.insert(id, chain);
    chain
}
fn cross_into(arena: &RealmArena, node: NodeId, m: Option<M4>) -> Option<M4> {
    let mut m = m?;
    if let Some(p) = perspective_step(arena, node) {
        m = multiply(&p, &m);
    }
    Some(if shares_context(arena, node) { m } else { flatten(&m) })
}

// Whether `node`'s children share its 3D rendering context: `transform-style: preserve-3d`, which a GROUPING property
// makes `flat` all the same (css-transforms-2 §6.1 — Chrome: an overflow other than visible, a filter, an opacity
// below 1, isolation, a blend mode, a clip path, a mask, a `will-change` naming one of them; not `contain: paint`).
fn shares_context(arena: &RealmArena, node: NodeId) -> bool {
    use style::computed_values::transform_style::T as TransformStyle;
    let Some(style) = box_style(arena, node) else { return false };
    let b = style.get_box();
    if b.transform_style != TransformStyle::Preserve3d {
        return false;
    }
    !groups(&style)
}
fn groups(style: &ComputedValues) -> bool {
    use style::computed_values::isolation::T as Isolation;
    use style::computed_values::mix_blend_mode::T as MixBlendMode;
    use style::computed_values::overflow_x::T as Overflow;
    let b = style.get_box();
    let effects = style.get_effects();
    b.overflow_x != Overflow::Visible
        || b.overflow_y != Overflow::Visible
        || effects.opacity < 1.0
        || b.isolation == Isolation::Isolate
        || effects.mix_blend_mode != MixBlendMode::Normal
        || !effects.filter.0.is_empty()
        || !effects.backdrop_filter.0.is_empty()
        || style.get_svg().mask_image.0.iter().any(|i| !matches!(i, style::values::computed::Image::None))
        || !matches!(style.get_svg().clip_path, style::values::generics::basic_shape::GenericClipPath::None)
        || will_change_groups(b)
}
// …a `will-change` naming one of them — asked only of a `preserve-3d` box, so its names are read off its text.
fn will_change_groups(b: &style::properties::style_structs::Box) -> bool {
    use style_traits::ToCss;
    const GROUPING: [&str; 8] = ["opacity", "filter", "backdrop-filter", "clip-path", "mask", "mask-image", "isolation", "mix-blend-mode"];
    let names = b.will_change.to_css_string();
    names.split(", ").any(|n| GROUPING.contains(&n))
}

// The parent's `perspective`, about its `perspective-origin`, in viewport coordinates — None for `none` (a negative depth
// is no value; zero is one, floored at a pixel as the function is).
fn perspective_step(arena: &RealmArena, node: NodeId) -> Option<M4> {
    use style::values::generics::box_::Perspective;
    let style = box_style(arena, node)?;
    let b = style.get_box();
    let Perspective::Length(d) = &b.perspective else { return None };
    if is_boxless(arena, node, &style) {
        return None;
    }
    let [x, y, w, h] = laid_out_box(arena, node)?;
    let origin = &b.perspective_origin;
    let ox = resolve(&origin.horizontal, w);
    let oy = resolve(&origin.vertical, h);
    let mut p = translate([0.0; 3]);
    p[11] = -1.0 / f64::from(d.px()).max(1.0);
    Some(about([x + ox, y + oy, 0.0], &p))
}

// One element's own map (`transformStepOf`): its `translate`, `rotate`, `scale` and `transform`, composed in that order
// as one 4x4 (css-transforms-2 §8 — Chrome: `translate: 10px; transform: translateX(20px)` moves the box 30px), taken
// about its `transform-origin`. None for an element a transform does not apply to: a non-replaced INLINE box (Chrome
// leaves `a:hover { transform: translateY(-1px) }` measuring where the link is), or one that generates no box.
fn transform_step(arena: &RealmArena, node: NodeId) -> Option<M4> {
    let style = box_style(arena, node)?;
    let b = style.get_box();
    let ops = individual_transforms(b);
    if ops.is_empty() && b.transform.0.is_empty() {
        return None;
    }
    if is_boxless(arena, node, &style) || non_replaced_inline(arena, node, &style) {
        return None;
    }
    let [x, y, w, h] = laid_out_box(arena, node)?;
    let reference = euclid::default::Rect::new(
        euclid::default::Point2D::origin(),
        euclid::default::Size2D::new(Length::new(w as f32), Length::new(h as f32)),
    );
    let mut m = translate([0.0; 3]);
    for op in ops.iter().chain(b.transform.0.iter()) {
        use style::values::generics::transform::ToMatrix;
        m = multiply(&m, &exact(op.to_3d_matrix(Some(&reference)).ok()?.to_array()));
    }
    if m == translate([0.0; 3]) {
        return None;
    }
    let origin = &b.transform_origin;
    let o = [x + resolve(&origin.horizontal, w), y + resolve(&origin.vertical, h), f64::from(origin.depth.px())];
    Some(about(o, &m))
}
// A function's matrix with what is only floating-point noise around a whole number taken as that number: an exact
// quarter turn has EXACT components — `cos(90deg)` is 6.1e-17 through the library, and a browser reports a clean 0 —
// so a `rotateX(90deg)` puts a box exactly edge-on, and `rotateY(360deg)` is exactly no turn at all.
fn exact(m: [f64; 16]) -> M4 {
    m.map(|v| if (v - v.round()).abs() < 1e-12 { v.round() } else { v })
}
// `translate`, `rotate` and `scale`, as the transform functions they are.
fn individual_transforms(b: &style::properties::style_structs::Box) -> Vec<style::values::computed::TransformOperation> {
    use style::values::computed::transform::{Rotate, Scale, Translate};
    use style::values::computed::TransformOperation as Op;
    let mut ops = Vec::new();
    if let Translate::Translate(x, y, z) = &b.translate {
        ops.push(Op::Translate3D(x.clone(), y.clone(), *z));
    }
    match &b.rotate {
        Rotate::None => {}
        Rotate::Rotate(a) => ops.push(Op::Rotate(*a)),
        Rotate::Rotate3D(x, y, z, a) => ops.push(Op::Rotate3D(*x, *y, *z, *a)),
    }
    if let Scale::Scale(x, y, z) = &b.scale {
        ops.push(Op::Scale3D(*x, *y, *z));
    }
    ops
}
fn resolve(lp: &style::values::computed::LengthPercentage, basis: f64) -> f64 {
    f64::from(lp.resolve(Length::new(basis as f32)).px())
}

// Does `node` generate no box of its own — `display: contents`?
fn is_boxless(arena: &RealmArena, node: NodeId, style: &ComputedValues) -> bool {
    arena.get(node).is_some_and(|n| style.get_box().walk_display(n.rendering_tag()).is_contents())
}
// …or is it a non-replaced INLINE box: one the lines broke into fragments, or one laid out as a BLOCK for the block it
// holds among them (a used display, no computed one — a rendered `<legend>` is a block whatever it declares).
pub(crate) fn non_replaced_inline(arena: &RealmArena, node: NodeId, style: &ComputedValues) -> bool {
    let Some(n) = arena.get(node) else { return false };
    if laid_frags(arena, n).is_some() {
        return true;
    }
    let tag = n.rendering_tag();
    let d = style.get_box().walk_display(tag);
    matches!(d.outside(), DisplayOutside::Inline)
        && matches!(d.inside(), DisplayInside::Flow)
        && !crate::walk::replaced_or_control(arena, node, n)
        && !crate::walk::widget_tag(tag)
        && tag != "legend"
}

// A rect's image under `m`: the axis-aligned box its transformed quad occupies, which both rect APIs report. A corner
// ON the horizon has no image; the corners that do project decide it, and a quad with none left is nowhere.
pub(crate) fn transformed_rect(m: &M4, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
    let corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    let mut ext = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let mut any = false;
    for [cx, cy] in corners {
        let Some([px, py]) = project(m, cx, cy) else { continue };
        any = true;
        ext = [ext[0].min(px), ext[1].min(py), ext[2].max(px), ext[3].max(py)];
    }
    if !any {
        return [0.0; 4];
    }
    [ext[0], ext[1], ext[2] - ext[0], ext[3] - ext[1]]
}
// A point of the plane z = 0 under `m` (its homography: columns 1, 2 and 4, rows 1, 2 and 4), None on the horizon.
pub(crate) fn project(m: &M4, x: f64, y: f64) -> Option<[f64; 2]> {
    let w = m[3] * x + m[7] * y + m[15];
    if w == 0.0 {
        return None;
    }
    Some([(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w])
}

// `id`'s BORDER BOX as the page measures it (`renderedBox`): where its scrolls carried it, under every transform on the
// way — None where it generates no box.
pub(crate) fn rendered_box(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let style = box_style(arena, id)?;
    if is_boxless(arena, id, &style) {
        return None;
    }
    let b = laid_out_box(arena, id)?;
    Some(match transform_chain(arena, id) {
        Some(m) => transformed_rect(&m, b),
        None => b,
    })
}

// ── the scrollable overflow region ─────────────────────────────────────────────────────────────────────────────
// `scrollWidth` / `scrollHeight` (css-overflow-3 §3): how far the box's content reaches from the edge it scrolls FROM.
// Each box's EXTENT — its own box unioned with what its children reach, a child that clips taken at its own box in the
// axes it clips, a fixed one not at all — is kept in the memo, so a read is no walk of the subtree it measures.
#[derive(Clone, Copy)]
pub(crate) struct Extent {
    // The union with the box's own border box as its seed, `[left, top, right, bottom]`…
    outer: [f64; 4],
    // …the union of its IN-FLOW children's MARGIN boxes, at the place the flow gave them — the half of the region the
    // box's own end padding extends (§3.2)…
    inflow: [f64; 4],
    // …and the children's reach without the seed, which sees a box in the BORDER region (a table caption, a negative
    // margin) as overflow past the padding box rather than lost behind the seed.
    kids: [f64; 4],
}
const NO_REACH: [f64; 4] = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
fn union(a: &mut [f64; 4], [l, t, r, b]: [f64; 4]) {
    *a = [a[0].min(l), a[1].min(t), a[2].max(r), a[3].max(b)];
}

fn extent(arena: &RealmArena, id: NodeId) -> Option<Extent> {
    if let Some(&e) = memo(arena).extents.get(&id) {
        return Some(e);
    }
    let [x, y, w, h] = if Some(id) == arena.layout_root { root_scroll_seed(arena, id)? } else { placed_box(arena, id)? };
    let mut e = Extent { outer: [x, y, x + w, y + h], inflow: NO_REACH, kids: NO_REACH };
    let node = arena.get(id)?;
    for c in box_children(arena, id) {
        let Some(cn) = arena.get(c) else { continue };
        let b = laid(arena, cn);
        // (…a FIXED box is anchored to the viewport, no scrollable content of anything: Chrome reports a page holding
        // one at `top: 900px` exactly one viewport tall)
        if b.is_some_and(is_fixed) {
            continue;
        }
        let Some(mut reach) = extent(arena, c).map(|ce| ce.outer) else { continue };
        // (…content that overflows a CLIPPING box is scrollable within it, in the axes it clips, and no content of what
        // is around it: Chrome, a 200px `overflow: auto` box over 2400px of rows gives html / body / box 681 / 200 / 2400)
        if let Some(b) = b.filter(|b| b.clip & (crate::layout::CLIP_X | crate::layout::CLIP_Y) != 0) {
            if b.clip & crate::layout::CLIP_X != 0 {
                [reach[0], reach[2]] = [b.x, b.x + b.w];
            }
            if b.clip & crate::layout::CLIP_Y != 0 {
                [reach[1], reach[3]] = [b.y, b.y + b.h];
            }
        }
        union(&mut e.outer, reach);
        union(&mut e.kids, reach);
        let Some(b) = b.filter(|b| b.out_of_flow == 0) else { continue };
        // (…by its MARGIN box where it has one — not a table's internal box, CSS 2.1 §17.5, nor a `<br>` — at the
        // place the flow gave it, its own relative shift taken back off)
        let m = if margin_box_applies(arena, c) { b.edges.map_or([0.0; 4], |e| [e[8], e[9], e[10], e[11]]) } else { [0.0; 4] };
        let [fx, fy] = [b.x - b.rel[0], b.y - b.rel[1]];
        union(&mut e.inflow, [fx - m[3], fy - m[0], fx + b.w + m[1], fy + b.h + m[2]]);
    }
    // (…and the anonymous boxes the pass made of its content, which reach as far as their boxes)
    for &[ax, ay, aw, ah] in node.anon_boxes.as_deref().unwrap_or(&[]) {
        let reach = [ax, ay, ax + aw, ay + ah];
        union(&mut e.outer, reach);
        union(&mut e.kids, reach);
        union(&mut e.inflow, reach);
    }
    memo(arena).extents.insert(id, e);
    Some(e)
}
// The boxes an element's box holds: its `::before`, its flat-tree children — a box-less one replaced by its own — and
// its `::after`, each one the current layout gave a box or fragments.
pub(crate) fn box_children(arena: &RealmArena, id: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    push_box_children(arena, id, &mut out);
    out
}
fn push_box_children(arena: &RealmArena, id: NodeId, out: &mut Vec<NodeId>) {
    let Some(node) = arena.get(id) else { return };
    let [before, after] = node.pseudo_boxes;
    for c in before.into_iter().chain(flat_children(arena, node).iter().copied()).chain(after) {
        let Some(cn) = arena.get(c) else { continue };
        if cn.kind != NodeKind::Element {
            continue;
        }
        if laid(arena, cn).is_some() || laid_frags(arena, cn).is_some() {
            out.push(c);
        } else if box_style(arena, c).is_some_and(|s| s.get_box().walk_display(cn.rendering_tag()).is_contents()) {
            push_box_children(arena, c, out);
        }
    }
}
fn margin_box_applies(arena: &RealmArena, id: NodeId) -> bool {
    let Some(n) = arena.get(id) else { return false };
    let Some(s) = box_style(arena, id) else { return false };
    let d = s.get_box().walk_display(n.rendering_tag());
    !(n.rendering_tag() == "br" && matches!(d.outside(), DisplayOutside::Inline)) && !matches!(d.outside(), DisplayOutside::InternalTable)
}
// The seed of the ROOT's extent: the viewport's scrolling area — the initial containing block, and the root's MARGIN box
// where that reaches further (Chrome: `html { margin-top: 32px }` over a 2000px body scrolls 2048).
fn root_scroll_seed(arena: &RealmArena, root: NodeId) -> Option<[f64; 4]> {
    let b = laid(arena, arena.get(root)?)?;
    let [vw, vh] = arena.viewport;
    let [mt, mr, mb, ml] = b.edges.map_or([0.0; 4], |e| [e[8], e[9], e[10], e[11]]);
    let [x, y] = [(b.x - ml).min(0.0), (b.y - mt).min(0.0)];
    Some([x, y, vw.max(b.x + b.w + mr) - x, vh.max(b.y + b.h + mb) - y])
}

// The scrollable overflow region of `id` as `[width, height]` (`contentExtent`): from the edge it scrolls FROM to the
// far end of what is reachable — at least its padding box, and nothing behind the scroll origin. A scroll container's
// in-flow children's margin boxes take its end padding after them (§3.2: a `padding: 10px` scroller over a 110px child
// is 130); an `overflow: visible` (or `clip`) box reports the plain union. The root's is the viewport's, from the
// initial containing block. None for a box that has no scrolling area: none at all, or a non-replaced inline.
pub(crate) fn scroll_size(arena: &RealmArena, id: NodeId) -> Option<[f64; 2]> {
    let node = arena.get(id)?;
    let style = box_style(arena, id)?;
    if is_boxless(arena, id, &style) || non_replaced_inline(arena, id, &style) {
        return None;
    }
    let ext = extent(arena, id)?;
    let [from_left, from_top] = scroll_origin(arena, id, &style);
    if Some(id) == arena.layout_root {
        let [vw, vh] = arena.viewport;
        let w = if from_left { ext.outer[2].max(ext.kids[2]) } else { vw - ext.outer[0].min(ext.kids[0]) };
        let h = if from_top { ext.outer[3].max(ext.kids[3]) } else { vh - ext.outer[1].min(ext.kids[1]) };
        return Some([w.round(), h.round()]);
    }
    let b = laid(arena, node)?;
    let e = b.edges.unwrap_or([0.0; 12]);
    let [pt, pr, pb, pl, bt, br, bb, bl] = [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7]];
    // (…a border-collapse TABLE's region runs to its BORDER box's far corner: Chrome counts the far outer-half border in)
    let to_border = {
        use style::computed_values::border_collapse::T as BorderCollapse;
        matches!(style.get_box().clone_display().inside(), DisplayInside::Table)
            && style.get_inherited_table().border_collapse == BorderCollapse::Collapse
    };
    let pad = [b.x + bl, b.y + bt, b.x + b.w - if to_border { 0.0 } else { br }, b.y + b.h - if to_border { 0.0 } else { bb }];
    let kid = [
        (if ext.outer[0] < b.x { ext.outer[0] } else { pad[0] }).min(ext.kids[0]),
        (if ext.outer[1] < b.y { ext.outer[1] } else { pad[1] }).min(ext.kids[1]),
        (if ext.outer[2] > b.x + b.w { ext.outer[2] } else { pad[2] }).max(ext.kids[2]),
        (if ext.outer[3] > b.y + b.h { ext.outer[3] } else { pad[3] }).max(ext.kids[3]),
    ];
    let scrolls = b.clip & CLIP_SCROLLS != 0;
    let inflow = if scrolls { [ext.inflow[0] - pl, ext.inflow[1] - pt, ext.inflow[2] + pr, ext.inflow[3] + pb] } else { NO_REACH };
    let axis = |from_start: bool, start: f64, end: f64, kid_start: f64, kid_end: f64, in_start: f64, in_end: f64| {
        if from_start { end.max(kid_end).max(in_end) - start } else { end - start.min(kid_start).min(in_start) }
    };
    let w = axis(from_left, pad[0], pad[2], kid[0], kid[2], inflow[0], inflow[2]);
    let h = axis(from_top, pad[1], pad[3], kid[1], kid[3], inflow[1], inflow[3]);
    Some([w.round(), h.round()])
}
// The edges a box scrolls FROM, `[left, top]` (each true for that edge, false for the far one): a flex SCROLL container
// from its main-start corner (Chrome: a `row-reverse` row overflowing 200px leftwards reports 100 while visible, 300 once
// it scrolls), the root from where the initial containing block starts, any other box from its inline-start edge in a
// horizontal flow.
fn scroll_origin(arena: &RealmArena, id: NodeId, style: &ComputedValues) -> [bool; 2] {
    use crate::walk::Side;
    let d = style.get_box().clone_display();
    let scrolls = arena.get(id).and_then(|n| laid(arena, n)).is_some_and(|b| b.clip & CLIP_SCROLLS != 0);
    if matches!(d.inside(), DisplayInside::Flex) && scrolls {
        let plan = crate::walk::FlexPlan::of(style);
        return if plan.main_is_x {
            [plan.main_start != Side::Right, !plan.cross_far]
        } else {
            [!plan.cross_far, plan.main_start != Side::Bottom]
        };
    }
    if Some(id) == arena.layout_root {
        return [!crate::walk::principal_starts_right(arena, id), true];
    }
    let [_, _, inline_start, _] = crate::walk::flow_sides(style);
    [inline_start != Side::Right, true]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "scrollShift", scroll_shift_op, context_id);
    register(scope, ns, "stickyOffset", sticky_offset, context_id);
    register(scope, ns, "laidOutBox", laid_out_box_op, context_id);
    register(scope, ns, "renderedBox", rendered_box_op, context_id);
    register(scope, ns, "transformChain", transform_chain_op, context_id);
    register(scope, ns, "scrollSize", scroll_size_op, context_id);
    register(scope, ns, "scrollOffset", scroll_offset, context_id);
    register(scope, ns, "setScrollOffset", set_scroll_offset, context_id);
    register(scope, ns, "clipFlags", clip_flags, context_id);
    register(scope, ns, "layoutRootAlone", layout_root_alone, context_id);
}

// __dom.scrollShift(nid, below, out): the scroll shift of `nid`'s box (`scroll_shift`) — of a box it holds where `below`
// — written to the Float64Array `out` as `[x, y]`.
fn scroll_shift_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let below = args.get(1).is_true();
    let shift = match crate::dom::nid_arg(scope, &args, 0) {
        Some(id) => scroll_shift(crate::dom::realm(scope, cid), id, below),
        None => [0.0; 2],
    };
    crate::dom::write_f64s(args.get(2), &shift);
}

// __dom.laidOutBox(nid, out) / renderedBox(nid, out) / transformChain(nid, out) / scrollSize(nid, out) -> whether `nid`
// has one: its box where the page's scrolling carried it (`laid_out_box`), that box as the page measures it
// (`rendered_box`), the 4x4 that maps it to the viewport (`transform_chain`), and its scrollable overflow region's size
// (`scroll_size`) — written to the Float64Array `out`.
fn laid_out_box_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, laid_out_box);
}
fn rendered_box_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, rendered_box);
}
fn scroll_size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, scroll_size);
}
fn transform_chain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, transform_chain);
}
fn answer_into<const N: usize>(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
    read: fn(&RealmArena, NodeId) -> Option<[f64; N]>,
) {
    let cid = crate::dom::realm_id(scope, args);
    let answer = crate::dom::nid_arg(scope, args, 0).and_then(|id| read(crate::dom::realm(scope, cid), id));
    if let Some(vals) = answer {
        crate::dom::write_f64s(args.get(1), &vals);
    }
    rv.set(v8::Boolean::new(scope, answer.is_some()).into());
}

// __dom.stickyOffset(nid, out) -> whether `nid`'s box is a sticky one that has STUCK (`sticky_delta`), how far written
// to the Float64Array `out` as `[x, y]`.
fn sticky_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, sticky_delta);
}

// __dom.scrollOffset(nid, axis) -> the scroll offset `nid` keeps in `axis` (0 x, 1 y).
fn scroll_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let axis = (args.get(1).int32_value(scope).unwrap_or(0) as usize).min(1);
    let offset = crate::dom::nid_arg(scope, &args, 0)
        .and_then(|id| crate::dom::realm(scope, cid).get(id).map(|n| n.scroll[axis]))
        .unwrap_or(0.0);
    rv.set(v8::Number::new(scope, offset).into());
}

// __dom.setScrollOffset(nid, x, y): the scroll offset `nid` keeps, each axis given as a number (any other leaves it).
fn set_scroll_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let to = [1, 2].map(|i| args.get(i).is_number().then(|| args.get(i).number_value(scope)).flatten());
    // (…quietly: a scroll offset is no input to the layout — only to the geometry's)
    let arena = crate::dom::realm(scope, cid);
    arena.scrolled();
    if let Some(node) = arena.get_mut_quietly(id) {
        for (axis, v) in to.into_iter().enumerate() {
            if let Some(v) = v {
                node.scroll[axis] = v;
            }
        }
    }
}

// __dom.clipFlags(nid) -> how the last layout's box of `nid` clips its content (`layout::CLIP_*`), 0 for none.
fn clip_flags(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let flags = crate::dom::nid_arg(scope, &args, 0)
        .and_then(|id| {
            let arena = crate::dom::realm(scope, cid);
            arena.get(id).and_then(|n| laid(arena, n)).map(|b| b.clip)
        })
        .unwrap_or(0);
    rv.set(v8::Integer::new(scope, i32::from(flags)).into());
}

// __dom.layoutRootAlone(rootNid, width, height, viewportWidth, viewportHeight): a page laid out as its root box alone
// (`layoutRootAlone`) — that box at the origin, and no other box of an earlier layout left standing.
fn layout_root_alone(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(root) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let [w, h, vw, vh] = [1, 2, 3, 4].map(|i| args.get(i).number_value(scope).unwrap_or(0.0));
    let arena = crate::dom::realm(scope, cid);
    arena.begin_layout(root, [vw, vh]);
    let pass = arena.layout_pass;
    if let Some(node) = arena.get_mut_quietly(root) {
        node.layout_box = Some(Box::at(root.to_f64(), [0.0, 0.0, w, h]));
        node.layout_frags = None;
        node.laid_at = pass;
    }
}
