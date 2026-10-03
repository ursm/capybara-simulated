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

// Is this the box of a `position: fixed` element laid out against the VIEWPORT — which no scrolling moves?
fn is_fixed(b: &Box) -> bool {
    b.out_of_flow == OOF_FIXED && b.cb == CB_RECT
}

// The total scroll shift the page has carried `id`'s box by, `[x, y]`: the document's scroll, and every scroll
// container's around it, compounding up — less the distance a STICKY box among them (it included) has stuck. With
// `below`, the shift of a box `id` holds rather than of `id`'s own: an anonymous box, which no node names.
pub(crate) fn scroll_shift(arena: &RealmArena, id: NodeId, below: bool) -> [f64; 2] {
    let mut shift = [0.0; 2];
    let Some(node) = arena.get(id) else { return shift };
    let root = arena.layout_root;
    if !below {
        // A `position: fixed` box is laid out against the VIEWPORT, so no scrolling moves it — that is what fixed means,
        // and how a pinned header stays put while the page scrolls under it.
        if node.layout_box.as_ref().is_some_and(is_fixed) {
            return shift;
        }
        // The document's scroll moves the ROOT ELEMENT's own box, not just its descendants': `html`'s client rect sits
        // at `(-scrollX, -scrollY)` in every browser (Floating UI reads its scrollbar offset as `left + scrollLeft`).
        if Some(id) == root {
            return node.scroll;
        }
    }
    let mut at = if below { Some(id) } else { flat_parent(arena, id) };
    if !below {
        unstick(&mut shift, sticky_delta(arena, id));
    }
    while let Some(p) = at {
        let Some(pn) = arena.get(p) else { break };
        if Some(p) == root || pn.layout_box.as_ref().is_some_and(|b| b.clip & CLIP_SCROLLS != 0) {
            shift[0] += pn.scroll[0];
            shift[1] += pn.scroll[1];
        }
        // …a STICKY ancestor carries the box with it, as it carries its own; and a FIXED one ends the walk, after its
        // own scroll, which does move its content.
        unstick(&mut shift, sticky_delta(arena, p));
        if pn.layout_box.as_ref().is_some_and(is_fixed) {
            break;
        }
        at = flat_parent(arena, p);
    }
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
    let b = arena.get(id)?.layout_box.as_ref().filter(|b| b.position == POSITION_STICKY)?;
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
    let b = node.layout_box.as_ref()?;
    let mut rect = content_box(b);
    if b.clip & CLIP_SCROLLS != 0 {
        let [mut right, mut bottom] = [rect[0] + rect[2], rect[1] + rect[3]];
        for c in flat_children(arena, node).iter().chain(node.pseudo_boxes.iter().flatten()) {
            let Some(cb) = arena.get(*c).and_then(|n| n.layout_box.as_ref()) else { continue };
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
        if let Some(b) = pn.layout_box.as_ref().filter(|b| b.clip & CLIP_SCROLLS != 0) {
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

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "scrollShift", scroll_shift_op, context_id);
    register(scope, ns, "stickyOffset", sticky_offset, context_id);
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

// __dom.stickyOffset(nid, out) -> whether `nid`'s box is a sticky one that has STUCK (`sticky_delta`), how far written
// to the Float64Array `out` as `[x, y]`.
fn sticky_offset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let delta = crate::dom::nid_arg(scope, &args, 0).and_then(|id| sticky_delta(crate::dom::realm(scope, cid), id));
    if let Some(delta) = delta {
        crate::dom::write_f64s(args.get(1), &delta);
    }
    rv.set(v8::Boolean::new(scope, delta.is_some()).into());
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
    // (…quietly: a scroll offset is no input to the layout, nor to any memo a write would throw away)
    if let Some(node) = crate::dom::realm(scope, cid).get_mut_quietly(id) {
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
        .and_then(|id| crate::dom::realm(scope, cid).get(id).and_then(|n| n.layout_box.as_ref()).map(|b| b.clip))
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
    arena.clear_layout();
    arena.layout_root = Some(root);
    arena.viewport = [vw, vh];
    if let Some(node) = arena.get_mut_quietly(root) {
        node.layout_box = Some(Box::at(root.to_f64(), [0.0, 0.0, w, h]));
    }
}
