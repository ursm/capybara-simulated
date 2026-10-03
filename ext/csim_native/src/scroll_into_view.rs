// Bringing a box into view: which scroll boxes move, and to where — planned over the boxes the last layout left, and
// applied by the caller in order through the `scrollLeft` / `scrollTop` setters, which fire the events (layout.js
// `applyScrollIntoView` / `ensureInView`). Each step of a plan is applied while the plan is made, since an inner
// scroller's move is what carries the target for the outer ones, and the offsets are put back before it is answered.

use crate::dom::{NodeId, RealmArena};
use crate::geometry::{box_style, edges, flat_parent, inverse_homography, is_fixed, is_table_box, laid, laid_out_box, rendered_box, scroll_range, transform_chain, transformed_rect};
use crate::walk::Side;
use crate::layout::CLIP_SCROLLS;

// Where a box is aligned in a scrollport along one axis (`ScrollIntoViewOptions`' `block` / `inline`).
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Align {
    Start,
    Center,
    End,
    Nearest,
}
impl Align {
    fn of(code: i32) -> Align {
        match code {
            1 => Align::Center,
            2 => Align::End,
            3 => Align::Nearest,
            _ => Align::Start,
        }
    }
}

// The plan for CSSOM View §12.4's `scrollIntoView`: for EVERY ancestor scrolling box, innermost outwards — the
// viewport the last of them — the move that aligns `id`'s border box, grown by its `scroll-margin`, as `block` and
// `inline` ask, clamped to the box's range. Empty for an element with no box (§12.4 stops there: running the alignment
// against a zero rect scrolled the page toward its top) or a fixed one, which no scroller moves; and none past a fixed
// ancestor, which carries `id` with it — scrolling what lies outside it would move the page under it, and the target
// not at all.
fn cssom_plan(arena: &mut RealmArena, id: NodeId, block: Align, inline: Align) -> Vec<(NodeId, [f64; 2])> {
    let root = arena.layout_root;
    if rendered_box(arena, id).is_none() || Some(id) != root && arena.get(id).and_then(|n| laid(arena, n)).is_some_and(is_fixed) {
        return Vec::new();
    }
    // (…the box scrolled to is the border box grown by the gap a page asks to be left around it — how a site with a
    // fixed header keeps an anchor from landing under it)
    let [top, right, bottom, left] = box_style(arena, id).map_or([0.0; 4], |s| {
        let m = s.get_margin();
        [m.clone_scroll_margin_top(), m.clone_scroll_margin_right(), m.clone_scroll_margin_bottom(), m.clone_scroll_margin_left()].map(|l| f64::from(l.px()))
    });
    let mut plan = Plan::default();
    let mut at = if Some(id) == root { root } else { flat_parent(arena, id) };
    while let Some(p) = at {
        let is_root = Some(p) == root;
        let pb = arena.get(p).and_then(|n| laid(arena, n)).copied();
        if is_root || pb.is_some_and(|b| b.clip & CLIP_SCROLLS != 0) {
            if let (Some(port), Some([x, y, w, h])) = (scrollport(arena, p, is_root), box_in(arena, id, p)) {
                let [ax, ay] = physical(arena, p, block, inline);
                let dy = align_delta(y - top - port[1], h + top + bottom, port[3], ay);
                let dx = align_delta(x - left - port[0], w + left + right, port[2], ax);
                if dx != 0.0 || dy != 0.0 {
                    plan.step(arena, p, [dx, dy]);
                }
            }
            if is_root {
                break;
            }
        }
        if pb.is_some_and(|b| is_fixed(&b)) {
            break;
        }
        at = flat_parent(arena, p);
    }
    plan.done(arena)
}

// The plan a driver's interaction runs first (Blink's `scrollIntoViewIfNeeded`, CDP `DOM.scrollIntoViewIfNeeded`, which
// Cuprite and Playwright click through): nothing at all while `id` already shows — in the viewport and clipped away by
// no scroller — else every scroll box from the innermost out moved by `delta_if_needed`. A gratuitous scroll moves the
// page out from under the rest of a test, and fires `scroll` at every ancestor an editor or a virtual scroller reacts
// to.
fn if_needed_plan(arena: &mut RealmArena, id: NodeId, nearest: bool) -> Vec<(NodeId, [f64; 2])> {
    let root = arena.layout_root;
    let [vw, vh] = arena.viewport;
    let Some([x, y, w, h]) = rendered_box(arena, id) else { return Vec::new() };
    if !crate::hit_test::clipped_away(arena, id) && fits_within(x, w, vw) && fits_within(y, h, vh) {
        return Vec::new();
    }
    let mut plan = Plan::default();
    let mut at = Some(id);
    while let Some(p) = at {
        at = flat_parent(arena, p);
        let is_root = Some(p) == root;
        let scrolls = arena.get(p).and_then(|n| laid(arena, n)).is_some_and(|b| b.clip & CLIP_SCROLLS != 0);
        if !is_root && !(p != id && scrolls) {
            continue;
        }
        let visible = if is_root { Some([0.0, 0.0, vw, vh]) } else { laid_out_box(arena, p) };
        let (Some([vx, vy, vw, vh]), Some([x, y, w, h])) = (visible, box_in(arena, id, p)) else { continue };
        // (…already fully showing in THIS box: left alone, the one case Blink's `IfNeeded` does nothing for)
        if fits_within(x - vx, w, vw) && fits_within(y - vy, h, vh) {
            continue;
        }
        let dx = delta_if_needed(x - vx, w, vw, nearest);
        let dy = delta_if_needed(y - vy, h, vh, nearest);
        if dx != 0.0 || dy != 0.0 {
            plan.step(arena, p, [dx, dy]);
        }
    }
    plan.done(arena)
}

// The scrollport `p` aligns against, `[x, y, w, h]` in viewport coordinates: the viewport for the root, else its PADDING
// box — borders neither scroll nor count toward the span (Chrome aligns `end` against `top + clientHeight`) — where the
// page's scrolling put it, untransformed, as the clip is and as its client box is.
fn scrollport(arena: &RealmArena, p: NodeId, is_root: bool) -> Option<[f64; 4]> {
    if is_root {
        let [w, h] = arena.viewport;
        return Some([0.0, 0.0, w, h]);
    }
    let [x, y, w, h] = laid_out_box(arena, p)?;
    let e = edges(arena, p).map_or([0.0; 12], |e| e.e);
    // (…the CLIENT box: a table's is its border box, its borders sitting in its grid)
    let table = box_style(arena, p).is_some_and(|s| is_table_box(arena, p, &s));
    let [cw, ch] = if table { [w, h] } else { [(w - e[5] - e[7]).max(0.0), (h - e[4] - e[6]).max(0.0)] };
    Some([x + e[7], y + e[4], cw, ch])
}

// A plan as it is made: where each box it moved goes, and where each was — held only until it is put back.
#[derive(Default)]
struct Plan {
    moves: Vec<(NodeId, [f64; 2])>,
    was: Vec<(NodeId, [f64; 2])>,
}
impl Plan {
    // Move `p` by `delta`, clamped to its range — applied now, so the boxes outside it see it.
    fn step(&mut self, arena: &mut RealmArena, p: NodeId, delta: [f64; 2]) {
        let Some(was) = arena.get(p).map(|n| n.scroll) else { return };
        let to = match scroll_range(arena, p) {
            Some(range) => [0, 1].map(|a| (was[a] + delta[a]).clamp(range[a][0], range[a][1])),
            None => [was[0] + delta[0], was[1] + delta[1]],
        };
        self.was.push((p, was));
        self.moves.push((p, to));
        set_scroll(arena, p, to);
    }
    // …and answered with every offset it moved put back as it was: the caller applies the moves through the setters,
    // which compare against what a box has now and fire the events.
    fn done(self, arena: &mut RealmArena) -> Vec<(NodeId, [f64; 2])> {
        for &(p, was) in self.was.iter().rev() {
            set_scroll(arena, p, was);
        }
        self.moves
    }
}

fn set_scroll(arena: &mut RealmArena, p: NodeId, to: [f64; 2]) {
    arena.scrolled();
    if let Some(node) = arena.get_mut_quietly(p) {
        node.scroll = to;
    }
}

// `id`'s border box in `p`'s own coordinates — the frame its scrollport and its offsets are in: the box the page
// measures, mapped back through every transform on `p`'s way to the viewport (Chrome scrolls a `scale(0.5)` scroller
// to the target's offset in its content, 400, not to where the halved box is drawn, 198.5). None where a transform
// flattens it, and nothing maps back.
fn box_in(arena: &RealmArena, id: NodeId, p: NodeId) -> Option<[f64; 4]> {
    let r = rendered_box(arena, id)?;
    match transform_chain(arena, p) {
        Some(m) => Some(transformed_rect(&inverse_homography(&m)?, r)),
        None => Some(r),
    }
}

// `block` and `inline` as the alignments on `p`'s physical axes, `[x, y]` (CSSOM View §12.3 reads them in the scroll
// box's writing mode): a vertical mode's block axis is the horizontal one, and an axis whose start is its right or
// bottom edge — an rtl inline axis, a `vertical-rl` block axis — has its start and end the other way about.
fn physical(arena: &RealmArena, p: NodeId, block: Align, inline: Align) -> [Align; 2] {
    let Some(style) = box_style(arena, p) else { return [inline, block] };
    let [block_start, _, inline_start, _] = crate::walk::flow_sides(&style);
    let flip = |a: Align, far: bool| match (a, far) {
        (Align::Start, true) => Align::End,
        (Align::End, true) => Align::Start,
        _ => a,
    };
    if matches!(block_start, Side::Left | Side::Right) {
        [flip(block, block_start == Side::Right), flip(inline, inline_start == Side::Bottom)]
    } else {
        [flip(inline, inline_start == Side::Right), flip(block, block_start == Side::Bottom)]
    }
}

// CSSOM View §12.3 for one axis: how far the scroller must move so a box at `pos` (scrollport-relative) of length `size`
// sits where `align` asks in a `visible`-long scrollport. `nearest` is the one that may not move: not while the box
// fully fits, else the least move to the closer edge — crossing over for a box LONGER than the port, where a start edge
// sticking out aligns the END edge (the minimal move, since the long box covers the port either way).
fn align_delta(pos: f64, size: f64, visible: f64, align: Align) -> f64 {
    match align {
        Align::Center => pos - (visible - size) / 2.0,
        Align::End => (pos + size) - visible,
        Align::Start => pos,
        Align::Nearest if fits_within(pos, size, visible) => 0.0,
        Align::Nearest if pos < 0.0 => if size > visible { (pos + size) - visible } else { pos },
        Align::Nearest => if size > visible { pos } else { (pos + size) - visible },
    }
}

// Blink's `ScrollAlignment::CenterIfNeeded` for one axis, each branch measured against Chrome 151: FULLY SHOWN — inside
// the port, or covering it — moves nothing; PARTIALLY shown moves the least to the closer edge (a 1000px panel 100px
// down a 681px viewport lands at 100); ENTIRELY out of view is CENTRED, rounded to a whole pixel as Blink keeps a scroll
// offset, half up (1549 for the 1548.5 the centre works out to, from above and from below alike). `nearest` takes the
// least move in every case, as Selenium's element-click does.
fn delta_if_needed(pos: f64, size: f64, visible: f64, nearest: bool) -> f64 {
    if fits_within(pos, size, visible) {
        return 0.0;
    }
    let least = if pos < 0.0 || size > visible { pos } else { (pos + size) - visible };
    if nearest || (pos < visible && pos + size > 0.0) {
        return least;
    }
    crate::walk::js_round(pos - (visible - size) / 2.0)
}

// Is a box at `pos` of length `size` fully shown in a `visible`-long port — inside it, or covering it?
fn fits_within(pos: f64, size: f64, visible: f64) -> bool {
    (pos >= 0.0 && pos + size <= visible) || (pos <= 0.0 && pos + size >= visible)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "scrollIntoViewPlan", plan_op, context_id);
}

// __dom.scrollIntoViewPlan(nid, ifNeeded, block, inline) -> Float64Array `[scroller nid, x, y, …]`, innermost first: the
// moves that bring `nid` into view — §12.4's `scrollIntoView` with `block` / `inline` as alignment codes (0 start, 1
// center, 2 end, 3 nearest), or with `ifNeeded` a driver's scroll-if-needed, centring (`inline` 1) or the least move
// (3).
fn plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let if_needed = args.get(1).is_true();
    let [block, inline] = [2, 3].map(|i| Align::of(args.get(i).int32_value(scope).unwrap_or(0)));
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = crate::dom::realm(scope, cid);
    let plan = if if_needed { if_needed_plan(arena, id, inline == Align::Nearest) } else { cssom_plan(arena, id, block, inline) };
    let out: Vec<f64> = plan.into_iter().flat_map(|(p, [x, y])| [p.to_f64(), x, y]).collect();
    rv.set(crate::dom::f64_array(scope, &out).into());
}
