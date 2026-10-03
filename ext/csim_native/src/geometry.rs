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

// Whether `id` is a fieldset's RENDERED LEGEND (HTML §15.3.13): the first child box of the fieldset's box that is a
// `<legend>`, neither floated nor absolutely positioned — so one that generates no box is passed over, one reached
// through a `display: contents` wrapper or a slot counts, and a box-less fieldset has none (Chrome and Firefox).
pub(crate) fn rendered_legend(arena: &RealmArena, id: NodeId) -> bool {
    use style::computed_values::float::T as Float;
    use style::computed_values::position::T as Position;
    use style::values::specified::box_::Display;
    if !arena.get(id).is_some_and(|n| n.is_html_named("legend")) {
        return false;
    }
    let boxless = |c: NodeId| arena.get(c).is_some_and(|n| n.kind == NodeKind::Element)
        && box_style(arena, c).is_some_and(|s| s.get_box().walk_display(arena.get(c).map_or("", |n| n.rendering_tag())).is_contents());
    let mut fieldset = flat_parent(arena, id);
    while let Some(p) = fieldset.filter(|&p| boxless(p)) {
        fieldset = flat_parent(arena, p);
    }
    let Some(fieldset) = fieldset.filter(|&p| arena.get(p).is_some_and(|n| n.is_html_named("fieldset"))) else { return false };
    let mut stack: Vec<NodeId> = arena.get(fieldset).map_or(Vec::new(), |n| flat_children(arena, n).iter().rev().copied().collect());
    while let Some(c) = stack.pop() {
        if boxless(c) {
            stack.extend(arena.get(c).map_or(Vec::new(), |n| flat_children(arena, n).iter().rev().copied().collect::<Vec<_>>()));
            continue;
        }
        if !arena.get(c).is_some_and(|n| n.is_html_named("legend")) {
            continue;
        }
        let in_flow = box_style(arena, c).is_some_and(|cs| {
            let b = cs.get_box();
            b.clone_display() != Display::None && b.clone_float() == Float::None && !matches!(b.clone_position(), Position::Absolute | Position::Fixed)
        });
        if in_flow {
            return c == id;
        }
    }
    false
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
pub(crate) fn is_fixed(b: &Box) -> bool {
    b.out_of_flow == OOF_FIXED && b.cb == CB_RECT
}

// The total scroll shift the page has carried `id`'s box by, `[x, y]`: the document's scroll, and every scroll
// container's around it, compounding up its containing-block chain — less the distance a STICKY box among them (it
// included) has stuck.
pub(crate) fn scroll_shift(arena: &RealmArena, id: NodeId) -> [f64; 2] {
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
    let mut shift = scrolled_by(arena, id).map_or([0.0; 2], |p| shift_below(arena, p));
    unstick(&mut shift, sticky_delta(arena, id));
    shift
}
// …the box whose scrolling carries `id`'s: its parent, or an out-of-flow box's CONTAINING BLOCK — the initial one, the
// root's, where it names none — so a scroll container between an absolutely positioned box and the block it is placed
// in moves it no more than it clips it (Chrome: an `absolute` box at `top: 4px` inside an unpositioned scroller stays
// at 4 however far that scroller scrolls).
fn scrolled_by(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let node = arena.get(id)?;
    match laid(arena, node) {
        Some(b) if b.out_of_flow != 0 => node.containing_block.or(arena.layout_root),
        _ => flat_parent(arena, id),
    }
}
// …the shift of the boxes `p` holds: its own scroll where it is the root or a scroll container, less what it has stuck
// if it is sticky, and its ancestors' — none past a FIXED one, whose own scroll still moves its content.
fn shift_below(arena: &RealmArena, p: NodeId) -> [f64; 2] {
    if let Some(&shift) = memo(arena).below.get(&p) {
        return shift;
    }
    let Some(pn) = arena.get(p) else { return [0.0; 2] };
    let b = laid(arena, pn);
    let mut shift = if b.is_some_and(is_fixed) { [0.0; 2] } else { scrolled_by(arena, p).map_or([0.0; 2], |up| shift_below(arena, up)) };
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

// What a pass laid out, kept on the nodes for the geometry: each record's box (`NodeData::layout_box`), each INLINE
// box's fragments in place of one, off its fragment rows `[inline index, x, y, w, h]` and the node each inline entry is
// (`inline_nids`, `NodeData::layout_frags`), each out-of-flow box's containing block, which its record names by its own
// index (`NodeData::containing_block`), and each container's anonymous boxes, named in `anon` as `[record, kind,
// container nid, ordinal]` (`NodeData::anon_boxes`) — all of it the current layout's (`laid_at`).
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
            node.layout_box = Some(*b);
            node.layout_frags = None;
            node.laid_at = pass;
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
    reclamp_scrolls(arena);
}

// Every scroll offset the page holds, clamped to the range its box has now — a scroller whose content shrank shows its
// end, as a browser re-clamps (silently: Chrome fires no `scroll` for it) — and one with no box kept as it is, for the
// box it gets back (Chrome: a scroller hidden with `display: none` and shown again is where it was).
fn reclamp_scrolls(arena: &mut RealmArena) {
    let mut moved = false;
    for id in arena.scrolled_nodes.clone() {
        let Some(range) = scroll_range(arena, id) else { continue };
        let Some(node) = arena.get_mut_quietly(id) else { continue };
        for (axis, [min, max]) in range.into_iter().enumerate() {
            let v = node.scroll[axis].clamp(min, max);
            moved |= v != node.scroll[axis];
            node.scroll[axis] = v;
        }
    }
    let held = arena.scrolled_nodes.iter().copied().filter(|&id| arena.get(id).is_some_and(|n| n.scroll != [0.0; 2]));
    arena.scrolled_nodes = held.collect();
    if moved {
        arena.scrolled();
    }
}
// The range `id`'s scroll offsets may take in each axis, `[min, max]`: from 0 to how far its region reaches past its
// scrollport — the viewport for the root, else its padding box — or to 0 from minus that where it scrolls from its far
// edge. None for a node with no box.
pub(crate) fn scroll_range(arena: &RealmArena, id: NodeId) -> Option<[[f64; 2]; 2]> {
    let [w, h, from_left, from_top] = scroll_size(arena, id)?;
    let [port_w, port_h] = if Some(id) == arena.layout_root {
        arena.viewport
    } else {
        let b = laid(arena, arena.get(id)?)?;
        let e = b.edges.unwrap_or([0.0; 12]);
        [b.w - e[5] - e[7], b.h - e[4] - e[6]]
    };
    let span = |size: f64, port: f64, from_start: f64| {
        let reach = (size - port).max(0.0);
        if from_start == 1.0 { [0.0, reach] } else { [-reach, 0.0] }
    };
    Some([span(w, port_w, from_left), span(h, port_h, from_top)])
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
    let [sx, sy] = scroll_shift(arena, id);
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
    let tag = n.rendering_tag();
    // (…a widget's inline-level box is an inline-block whatever the lines made of it — HTML's button layout — a
    // replaced element's is atomic, and a fieldset's rendered legend is a block whatever it declares)
    if crate::walk::replaced_or_control(arena, node, n) || crate::walk::widget_tag(tag) || rendered_legend(arena, node) {
        return false;
    }
    if laid_frags(arena, n).is_some() {
        return true;
    }
    let d = style.get_box().walk_display(tag);
    matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)
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
// The map back: `m`'s homography inverted, as a matrix `project` reads — what takes a point of the viewport to the
// plane `m` maps from. None where `m` flattens that plane onto a line, which nothing maps back from.
pub(crate) fn inverse_homography(m: &M4) -> Option<M4> {
    let [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], m[15]];
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let mut inv = [0.0; 16];
    [inv[0], inv[4], inv[12]] = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det];
    [inv[1], inv[5], inv[13]] = [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det];
    [inv[3], inv[7], inv[15]] = [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
    Some(inv)
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

// `id`'s CLIENT RECTS as `getClientRects` answers them: one per line an inline box broke over, else its border box —
// where the page's scrolling carried each, under every transform on the way. None where it generates no box.
pub(crate) fn client_rects(arena: &RealmArena, id: NodeId) -> Option<Vec<[f64; 4]>> {
    let style = box_style(arena, id)?;
    if is_boxless(arena, id, &style) {
        return None;
    }
    let pieces = match arena.get(id).and_then(|n| laid_frags(arena, n)).filter(|f| f.len() > 1) {
        Some(frags) => {
            let [sx, sy] = scroll_shift(arena, id);
            frags.iter().map(|&[x, y, w, h]| [x - sx, y - sy, w, h]).collect()
        }
        None => vec![laid_out_box(arena, id)?],
    };
    Some(match transform_chain(arena, id) {
        Some(m) => pieces.into_iter().map(|r| transformed_rect(&m, r)).collect(),
        None => pieces,
    })
}

// The map the PAINTER draws `id` under, `[a, b, c, d, e, f]` — a 2D affine, all a canvas has — None where no transform
// moves it, and `Some(None)` where one does that the painter cannot express at all, which it must not read as "none"
// and draw at the layout position. A homography whose projective row is `0, 0, w` is no projection: it is a UNIFORM
// scale by `1 / w`, which an affine holds exactly — the shape `perspective(d) translateZ(z)` and `matrix3d(…, w)` both
// take. A genuine projection is the affine that carries three of the box's corners where the projection carries them:
// the homography's LINEAR PART is not the same map at all — where a projection puts the box on a line (`rotateX(90deg)`
// about a perspective origin the box is centred on) it is perfectly invertible, and the painter inked a band where the
// box has no area. Three corners is all an affine has room for, so the fourth lands at `p1 + p2 - p0` — a parallelogram
// where the truth is a trapezoid — and the painter clips to the true quad (`paint_quad`).
pub(crate) fn paint_transform(arena: &RealmArena, id: NodeId) -> Option<Option<[f64; 6]>> {
    let m = transform_chain(arena, id)?;
    if m[3] == 0.0 && m[7] == 0.0 {
        let w = if m[15] == 0.0 { 1.0 } else { 1.0 / m[15] };
        return Some(Some([m[0] * w, m[1] * w, m[4] * w, m[5] * w, m[12] * w, m[13] * w]));
    }
    let Some([x, y, w, h]) = laid_out_box(arena, id).filter(|r| r[2] != 0.0 && r[3] != 0.0) else { return Some(None) };
    let corners = (project(&m, x, y), project(&m, x + w, y), project(&m, x, y + h));
    let (Some(p0), Some(p1), Some(p2)) = corners else { return Some(None) };
    let [a, b] = [(p1[0] - p0[0]) / w, (p1[1] - p0[1]) / w];
    let [c, d] = [(p2[0] - p0[0]) / h, (p2[1] - p0[1]) / h];
    Some(Some([a, b, c, d, p0[0] - a * x - c * y, p0[1] - b * x - d * y]))
}
// …and the true QUAD a projected box covers, its corners clockwise from the top left — for the painter to clip that
// parallelogram to. None where the map is affine (the quad is exactly what the matrix draws) or a corner has no image.
pub(crate) fn paint_quad(arena: &RealmArena, id: NodeId) -> Option<[f64; 8]> {
    let m = transform_chain(arena, id)?;
    if m[3] == 0.0 && m[7] == 0.0 {
        return None;
    }
    let [x, y, w, h] = laid_out_box(arena, id).filter(|r| r[2] != 0.0 && r[3] != 0.0)?;
    let [p0, p1, p2, p3] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(|[cx, cy]| project(&m, cx, cy));
    let [p0, p1, p2, p3] = [p0?, p1?, p2?, p3?];
    Some([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]])
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
    // (…its LINE BOXES' content, which the scrollable overflow holds as it holds boxes — a `nowrap` line, an unbreakable
    // word — and which the end padding follows as an in-flow child's margin box does)
    if let Some((bx, [l, t, r, b])) = laid(arena, node).and_then(|b| Some(((b.x, b.y), b.line_rect?))) {
        let reach = [bx.0 + l, bx.1 + t, bx.0 + r, bx.1 + b];
        union(&mut e.outer, reach);
        union(&mut e.kids, reach);
        union(&mut e.inflow, reach);
    }
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
// far end of what is reachable — at least its padding box, and nothing behind the scroll origin — and then whether it
// scrolls from its left and its top edge (1) or the far one (0), where its offsets run negative (CSSOM View §6). A
// scroll container's in-flow children's margin boxes take its end padding after them (§3.2: a `padding: 10px` scroller
// over a 110px child is 130); an `overflow: visible` (or `clip`) box reports the plain union. The root's is the
// viewport's, from the initial containing block. None for a box that has no scrolling area: none at all, or a
// non-replaced inline.
pub(crate) fn scroll_size(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
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
        return Some([w.round(), h.round(), f64::from(u8::from(from_left)), f64::from(u8::from(from_top))]);
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
    Some([w.round(), h.round(), f64::from(u8::from(from_left)), f64::from(u8::from(from_top))])
}
// The edges a box scrolls FROM, `[left, top]` (each true for that edge, false for the far one): a flex SCROLL container
// from its main-start corner (Chrome: a `row-reverse` row overflowing 200px leftwards reports 100 while visible, 300 once
// it scrolls), the root from where the initial containing block starts, any other box from its inline-start edge in a
// horizontal flow. It describes where THIS layout puts the content, not where the spec would — an origin that disagreed
// with the boxes would call geometry the hit test can see unreachable: block flow honours `direction: rtl` (a 300px
// child in a 100px box lands at -200..100, as in Chrome) but places a VERTICAL writing mode physically (0..300, where
// Chrome has -200..100), so the origin stays physical there until that placement moves.
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

// ── the used insets ────────────────────────────────────────────────────────────────────────────────────────────
// What `getComputedStyle` reports of a POSITIONED box's `top` / `right` / `bottom` / `left`, `[declared…, used…]` each
// top / right / bottom / left (NaN for none), from the box the pass placed and the containing block it placed it in:
// an inset the page DECLARED is reported as itself, resolved against that block (Chrome: `left: 0; right: 0; width:
// 40px; margin: auto` answers `left: 0px` though the box sits 180px in), and only an `auto` one is derived from the
// box — an absolutely positioned box's distance to its containing block's padding edge past its margin, a relatively
// positioned (or sticky) box's SHIFT. None for a static box or one with no box; and an axis of an INLINE box whose
// inset is a percentage reports none at all, its computed value standing, as a browser does.
pub(crate) fn used_insets(arena: &RealmArena, id: NodeId) -> Option<[f64; 8]> {
    use style::computed_values::position::T as Position;
    let style = box_style(arena, id)?;
    let position = style.get_box().clone_position();
    if position == Position::Static || is_boxless(arena, id, &style) {
        return None;
    }
    let [x, y, w, h] = placed_box(arena, id)?;
    let [cx, cy, cw, ch] = inset_containing_block(arena, id, position)?;
    let pos = style.get_position();
    let resolve = |v, basis: f64| crate::walk::inset_lp(v).ok().flatten().map(|lp| f64::from(lp.resolve(Length::new(basis as f32)).px()));
    let mut declared = [resolve(&pos.top, ch), resolve(&pos.right, cw), resolve(&pos.bottom, ch), resolve(&pos.left, cw)];
    let mut used: [Option<f64>; 4];
    if matches!(position, Position::Absolute | Position::Fixed) {
        let e = edges(arena, id).map_or([0.0; 12], |e| e.e);
        let [mt, mr, mb, ml] = [e[8], e[9], e[10], e[11]];
        used = [Some(y - mt - cy), Some(cx + cw - (x + w + mr)), Some(cy + ch - (y + h + mb)), Some(x - ml - cx)];
    } else {
        // (…a relative SHIFT: the declared inset where there is one, else the opposite one's negation — and with both
        // `left` and `right` given, over-constrained, the containing block's `direction` drops one, §9.4.3)
        let [top, right, bottom, left] = declared;
        let dx = match (left, right) {
            (Some(l), Some(r)) => if flow_relative_rtl(arena, id) { -r } else { l },
            (Some(l), None) => l,
            (None, r) => -r.unwrap_or(0.0),
        };
        let dy = top.unwrap_or_else(|| -bottom.unwrap_or(0.0));
        used = [Some(dy), Some(-dx), Some(-dy), Some(dx)];
        for (axis, [start, end]) in [(0, [&pos.top, &pos.bottom]), (1, [&pos.left, &pos.right])] {
            if inline_percentage_axis(arena, id, &style, start, end) {
                let sides = if axis == 0 { [0, 2] } else { [3, 1] };
                for k in sides {
                    used[k] = None;
                    declared[k] = None;
                }
            }
        }
    }
    let mut out = [f64::NAN; 8];
    for k in 0..4 {
        out[k] = declared[k].unwrap_or(f64::NAN);
        out[4 + k] = used[k].unwrap_or(f64::NAN);
    }
    Some(out)
}
// The block an inset resolves against, `[x, y, w, h]` in document coordinates — the one the placement used: an
// absolutely positioned box's containing block's PADDING box (the viewport where it was placed against that), a sticky
// one's nearest scroller's content box (the viewport's, with none — css-position §sticky-pos: Chrome resolves `top:
// 10%` in a 100px block in a 200px `overflow: hidden` scroller to 20px), and a relative one's parent box's content box.
fn inset_containing_block(arena: &RealmArena, id: NodeId, position: style::computed_values::position::T) -> Option<[f64; 4]> {
    use style::computed_values::position::T as Position;
    let [vw, vh] = arena.viewport;
    match position {
        Position::Absolute | Position::Fixed => {
            let cb = arena.get(id)?.containing_block;
            Some(match cb {
                Some(cb) => padding_rect(arena, cb)?,
                None => [0.0, 0.0, vw, vh],
            })
        }
        Position::Sticky => {
            let mut at = flat_parent(arena, id);
            while let Some(p) = at {
                if arena.get(p).and_then(|n| laid(arena, n)).is_some_and(|b| b.clip & CLIP_SCROLLS != 0) {
                    return content_rect(arena, p);
                }
                at = flat_parent(arena, p);
            }
            Some([0.0, 0.0, vw, vh])
        }
        _ => content_rect(arena, crate::hit_test::box_parent_or_inline(arena, id)?),
    }
}
// A box's padding box and content box, `[x, y, w, h]` — an inline box's from where its first fragment starts to where
// its last one ends (a dropdown hung off a wrapping link opens under where the link STARTS: Chrome).
fn padding_rect(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let [x, y, w, h] = containing_extent(arena, id)?;
    let e = edges(arena, id).map_or([0.0; 12], |e| e.e);
    Some([x + e[7], y + e[4], (w - e[7] - e[5]).max(0.0), (h - e[4] - e[6]).max(0.0)])
}
fn content_rect(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let [x, y, w, h] = containing_extent(arena, id)?;
    let e = edges(arena, id).map_or([0.0; 12], |e| e.e);
    let [top, right, bottom, left] = [e[0] + e[4], e[1] + e[5], e[2] + e[6], e[3] + e[7]];
    Some([x + left, y + top, (w - left - right).max(0.0), (h - top - bottom).max(0.0)])
}
fn containing_extent(arena: &RealmArena, id: NodeId) -> Option<[f64; 4]> {
    let node = arena.get(id)?;
    if let Some(frags) = laid_frags(arena, node).filter(|f| f.len() > 1) {
        let (first, last) = (frags[0], frags[frags.len() - 1]);
        return Some([first[0], first[1], last[0] + last[2] - first[0], last[1] + last[3] - first[1]]);
    }
    placed_box(arena, id)
}
// Does `id`'s containing block run right to left — the nearest block around it, an inline box being no containing
// block (and one laid out as a block for the block it holds still an inline box here)?
fn flow_relative_rtl(arena: &RealmArena, id: NodeId) -> bool {
    use style::computed_values::direction::T as Direction;
    let mut at = flat_parent(arena, id);
    while let Some(p) = at.filter(|&p| arena.get(p).is_some_and(|n| n.kind == NodeKind::Element)) {
        let Some(style) = box_style(arena, p) else { return false };
        let d = style.get_box().walk_display(arena.get(p).map_or("", |n| n.rendering_tag()));
        if !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)) {
            return style.get_inherited_box().direction == Direction::Rtl;
        }
        at = flat_parent(arena, p);
    }
    false
}
// Is this axis of an INLINE box's insets — its start side's where that is given, else its end side's — a percentage?
fn inline_percentage_axis(
    arena: &RealmArena,
    id: NodeId,
    style: &ComputedValues,
    start: &style::values::computed::position::Inset,
    end: &style::values::computed::position::Inset,
) -> bool {
    let tag = arena.get(id).map_or("", |n| n.rendering_tag());
    let d = style.get_box().walk_display(tag);
    if !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow)) {
        return false;
    }
    let side = match crate::walk::inset_lp(start) {
        Ok(Some(lp)) => Some(lp),
        _ => crate::walk::inset_lp(end).ok().flatten(),
    };
    side.is_some_and(|lp| lp.has_percentage())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "scrollShift", scroll_shift_op, context_id);
    register(scope, ns, "stickyOffset", sticky_offset, context_id);
    register(scope, ns, "laidOutBox", laid_out_box_op, context_id);
    register(scope, ns, "renderedBox", rendered_box_op, context_id);
    register(scope, ns, "transformChain", transform_chain_op, context_id);
    register(scope, ns, "scrollSize", scroll_size_op, context_id);
    register(scope, ns, "scrollRange", scroll_range_op, context_id);
    register(scope, ns, "boxInfo", box_info_op, context_id);
    register(scope, ns, "usedInsets", used_insets_op, context_id);
    register(scope, ns, "renderedLegend", rendered_legend_op, context_id);
    register(scope, ns, "boxFragments", box_fragments_op, context_id);
    register(scope, ns, "clientRects", client_rects_op, context_id);
    register(scope, ns, "paintTransform", paint_transform_op, context_id);
    register(scope, ns, "paintQuad", paint_quad_op, context_id);
    register(scope, ns, "scrollOffset", scroll_offset, context_id);
    register(scope, ns, "setScrollOffset", set_scroll_offset, context_id);
    register(scope, ns, "clipFlags", clip_flags, context_id);
    register(scope, ns, "layoutRootAlone", layout_root_alone, context_id);
}

// __dom.scrollShift(nid, out): the scroll shift of `nid`'s box (`scroll_shift`), written to the Float64Array `out` as
// `[x, y]`.
fn scroll_shift_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let shift = match crate::dom::nid_arg(scope, &args, 0) {
        Some(id) => scroll_shift(crate::dom::realm(scope, cid), id),
        None => [0.0; 2],
    };
    crate::dom::write_f64s(args.get(1), &shift);
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
    answer_into(scope, &args, rv, |arena, id| scroll_size(arena, id).map(|[w, h, ..]| [w, h]));
}
// __dom.scrollRange(nid, out) -> whether `nid` has a box, and the range its offsets may take written to `out` as `[min x,
// max x, min y, max y]` (`scroll_range`): what a scroll offset written to it is clamped to.
fn scroll_range_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, |arena, id| scroll_range(arena, id).map(|[[x0, x1], [y0, y1]]| [x0, x1, y0, y1]));
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

// __dom.boxInfo(nid, out) -> whether the current layout gave `nid` a box: what it gave it, written to the Float64Array
// `out` as `BOX_INFO` numbers — the box `[x, y, w, h]` in document coordinates (an inline box's the union of its
// fragments), how many fragments it broke into (0 for a record's box), the basis its percentages resolved against, the
// margins its placement used (top, right, bottom, left), its own relative shift `[x, y]`, its edges as the pass used
// them (padding, border, margin, each top / right / bottom / left), which margins are `auto` (1 top, 2 right, 4 bottom,
// 8 left, with 16 where an edge resolved a percentage), whether it is out of flow (1, 2 `fixed`) and placed against the
// viewport, whether its height is `auto`, its `position`, how it clips, and whether it is a non-replaced inline box and
// a table box (`put_kind`) — NaN for what it has none of.
pub(crate) const BOX_INFO: usize = 32;
fn box_info(arena: &RealmArena, id: NodeId) -> Option<[f64; BOX_INFO]> {
    let node = arena.get(id)?;
    let mut out = [f64::NAN; BOX_INFO];
    if let Some(b) = laid(arena, node) {
        out[..4].copy_from_slice(&[b.x, b.y, b.w, b.h]);
        out[4] = 0.0;
        out[5] = b.cb_w.unwrap_or(f64::NAN);
        out[6..10].copy_from_slice(&b.used_margins.unwrap_or([f64::NAN; 4]));
        out[10..12].copy_from_slice(&b.rel);
        put_edges(arena, id, &mut out);
        out[25] = f64::from(b.out_of_flow);
        out[26] = if b.cb == CB_RECT { 1.0 } else { 0.0 };
        out[27] = if b.auto_height { 1.0 } else { 0.0 };
        out[28] = f64::from(b.position);
        out[29] = f64::from(b.clip);
        put_kind(arena, id, &mut out);
        return Some(out);
    }
    let frags = laid_frags(arena, node)?;
    out[..4].copy_from_slice(&placed_box(arena, id)?);
    out[4] = frags.len() as f64;
    out[10..12].copy_from_slice(&[0.0; 2]);
    out[25..30].copy_from_slice(&[0.0, 0.0, 1.0, 0.0, 0.0]);
    put_edges(arena, id, &mut out);
    put_kind(arena, id, &mut out);
    Some(out)
}
// …what kind of box it is: a non-replaced INLINE box, one laid out as a block for the block it holds included (no
// client box, no transform, an offset origin at its border box), and a TABLE box (its client box its border box).
fn put_kind(arena: &RealmArena, id: NodeId, out: &mut [f64; BOX_INFO]) {
    let Some(style) = box_style(arena, id) else { return };
    out[30] = if non_replaced_inline(arena, id, &style) { 1.0 } else { 0.0 };
    out[31] = if is_table_box(arena, id, &style) { 1.0 } else { 0.0 };
}
// Is `id` a TABLE box as the walk lays it out — whose client box is its border box, its borders in its grid? A widget's
// table display is HTML's flow-root block (`<button style="display: table">`, `button-layout/display-other`), and a
// replaced element's an inline-block.
pub(crate) fn is_table_box(arena: &RealmArena, id: NodeId, style: &ComputedValues) -> bool {
    let Some(n) = arena.get(id) else { return false };
    let tag = n.rendering_tag();
    matches!(style.get_box().walk_display(tag).inside(), DisplayInside::Table)
        && !crate::walk::widget_tag(tag)
        && !crate::walk::replaced_or_control(arena, id, n)
}
fn put_edges(arena: &RealmArena, id: NodeId, out: &mut [f64; BOX_INFO]) {
    if let Some(Edges { e, auto, percent }) = edges(arena, id) {
        out[12..24].copy_from_slice(&e);
        out[24] = f64::from(auto | if percent { 16 } else { 0 });
    }
}
// A box's EDGES — padding, border and margin, each top / right / bottom / left, an `auto` margin as 0 — with which
// margins are `auto` (`box_info`'s mask: 1 top, 2 right, 4 bottom, 8 left) and whether any resolved a percentage: the
// ones the pass laid it out with, or for a box the pass gave none of its own — a table row or row group, whose margins
// and padding do not apply and whose border is its cells' to draw (CSS 2.1 §17.5), an inline box, which the lines lay
// out by halves — as its style declares them, a percentage against its containing block's content width: what CSSOM
// reports of them.
pub(crate) struct Edges {
    pub(crate) e: [f64; 12],
    pub(crate) auto: u8,
    pub(crate) percent: bool,
}
pub(crate) fn edges(arena: &RealmArena, id: NodeId) -> Option<Edges> {
    let node = arena.get(id)?;
    let b = laid(arena, node);
    if let Some(e) = b.and_then(|b| b.edges) {
        let b = b?;
        let am = b.auto_margins;
        let auto = [(4, 1), (2, 2), (8, 4), (1, 8)].iter().fold(0, |m, &(from, to)| if am & from != 0 { m | to } else { m });
        return Some(Edges { e, auto, percent: b.percent_edges });
    }
    if b.is_none() && laid_frags(arena, node).is_none() {
        return None;
    }
    let style = box_style(arena, id)?;
    let basis = b.and_then(|b| b.cb_w).or_else(|| {
        let p = crate::hit_test::box_parent(arena, id)?;
        Some(content_box(laid(arena, arena.get(p)?)?)[2])
    }).unwrap_or(0.0);
    let (lps, walk_auto) = crate::walk::edge_lps(&style).ok()?;
    let px = |lp: Option<&style::values::computed::LengthPercentage>| {
        lp.map_or(0.0, |lp| f64::from(lp.resolve(Length::new(basis as f32)).px()))
    };
    let [bt, br, bb, bl] = crate::walk::used_borders(&style);
    let pad = |k: usize| px(lps[k]).max(0.0);
    let e = [pad(4), pad(5), pad(6), pad(7), bt, br, bb, bl, px(lps[0]), px(lps[1]), px(lps[2]), px(lps[3])];
    // (…the `auto` margins in `box_info`'s mask, from the walk's: 4 top, 2 right, 8 bottom, 1 left)
    let auto = [(4, 1), (2, 2), (8, 4), (1, 8)].iter().fold(0, |m, &(from, to)| if walk_auto & from != 0 { m | to } else { m });
    Some(Edges { e, auto, percent: lps.iter().flatten().any(|lp| lp.has_percentage()) })
}
// __dom.usedInsets(nid, out) -> whether `nid` is a positioned box with one: its insets as `getComputedStyle` reports
// them (`used_insets`), written to the Float64Array `out`.
fn used_insets_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, used_insets);
}
// __dom.renderedLegend(nid) -> whether the element is its fieldset's rendered legend (`rendered_legend`).
fn rendered_legend_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let legend = crate::dom::nid_arg(scope, &args, 0).is_some_and(|id| rendered_legend(crate::dom::realm(scope, cid), id));
    rv.set(v8::Boolean::new(scope, legend).into());
}
fn box_info_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, box_info);
}

// __dom.boxFragments(nid) -> Float64Array: an inline box's fragments, `[x, y, w, h]` each in document coordinates, in
// the order the lines broke it; empty for any other node.
fn box_fragments_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let flat: Vec<f64> = crate::dom::nid_arg(scope, &args, 0)
        .and_then(|id| {
            let arena = crate::dom::realm(scope, cid);
            arena.get(id).and_then(|n| laid_frags(arena, n)).map(|f| f.iter().flatten().copied().collect())
        })
        .unwrap_or_default();
    rv.set(crate::dom::f64_array(scope, &flat).into());
}

// __dom.clientRects(nid) -> Float64Array: `nid`'s client rects, `[x, y, w, h]` each (`client_rects`), none for no box.
fn client_rects_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let flat: Vec<f64> = crate::dom::nid_arg(scope, &args, 0)
        .and_then(|id| client_rects(crate::dom::realm(scope, cid), id))
        .map(|rects| rects.into_iter().flatten().collect())
        .unwrap_or_default();
    rv.set(crate::dom::f64_array(scope, &flat).into());
}
// __dom.paintTransform(nid, out) -> 0 where no transform moves `nid`'s box, 1 with the affine the painter draws it under
// written to `out` (`paint_transform`), 2 where it has one the painter cannot express.
fn paint_transform_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let answer = crate::dom::nid_arg(scope, &args, 0).and_then(|id| paint_transform(crate::dom::realm(scope, cid), id));
    let kind = match answer {
        None => 0,
        Some(Some(affine)) => {
            crate::dom::write_f64s(args.get(1), &affine);
            1
        }
        Some(None) => 2,
    };
    rv.set(v8::Integer::new(scope, kind).into());
}
// __dom.paintQuad(nid, out) -> whether `nid`'s box projects to a quad the painter clips to, its corners written to `out`
// (`paint_quad`).
fn paint_quad_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, paint_quad);
}

// __dom.stickyOffset(nid, out) -> whether `nid`'s box is a sticky one that has STUCK (`sticky_delta`), how far written
// to the Float64Array `out` as `[x, y]`.
fn sticky_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    answer_into(scope, &args, rv, sticky_delta);
}

// __dom.scrollOffset(nid, axis, shown) -> the scroll offset `nid` keeps in `axis` (0 x, 1 y) — or, with `shown`, the
// one it shows: 0 while the last layout gave it no box (CSSOM View: `scrollTop` of an element with no associated box
// is zero — Chrome reads 0 under `display: none` and the kept offset again once it is shown).
fn scroll_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let axis = (args.get(1).int32_value(scope).unwrap_or(0) as usize).min(1);
    let shown = args.get(2).is_true();
    let offset = crate::dom::nid_arg(scope, &args, 0)
        .and_then(|id| {
            let arena = crate::dom::realm(scope, cid);
            let node = arena.get(id)?;
            (!shown || Some(id) == arena.layout_root || laid(arena, node).is_some()).then_some(node.scroll[axis])
        })
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
    let Some(node) = arena.get_mut_quietly(id) else { return };
    for (axis, v) in to.into_iter().enumerate() {
        if let Some(v) = v {
            node.scroll[axis] = v;
        }
    }
    if node.scroll != [0.0; 2] && !arena.scrolled_nodes.contains(&id) {
        arena.scrolled_nodes.push(id);
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
