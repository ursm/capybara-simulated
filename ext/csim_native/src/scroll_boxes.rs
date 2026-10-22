// Which boxes keep a SCROLL OFFSET (CSSOM View): the document's scrolling element, and every rendered scroll container
// — asked of the style as the document is styled now, not of the clip flags the last layout left on the boxes
// (walk.rs `clip_flags`), which move only when a pass runs: a panel that gains a class and restores its saved offset in
// the same tick asks before any pass has. And the box a mouse event's offset is measured from.

use style::computed_values::overflow_x::T as Overflow;
use style::properties::ComputedValues;
use style::values::computed::Display;

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};
use crate::rendered::{rendered, with_engine};
use crate::style::{primary_style, StyleEngine};
use crate::walk::{replaced_or_control, scrolls, WalkDisplay};

// The document element of `doc`, and HTML's "the body element": its `<body>` or `<frameset>` child.
fn document_element(arena: &RealmArena, doc: NodeId) -> Option<NodeId> {
    arena.get(doc)?.children.iter().copied().find(|&c| arena.get(c).is_some_and(|n| n.kind == NodeKind::Element))
}
fn body_element(arena: &RealmArena, doc: NodeId) -> Option<NodeId> {
    let root = arena.get(document_element(arena, doc)?).filter(|r| r.is_html_named("html"))?;
    root.children.iter().copied().find(|&c| arena.get(c).is_some_and(|n| n.is_html_named("body") || n.is_html_named("frameset")))
}

fn overflows(style: &ComputedValues) -> [Overflow; 2] {
    let b = style.get_box();
    [b.overflow_x, b.overflow_y]
}

// CSSOM View `scrollingElement`: the document element in standards mode; in quirks mode the body element where it is not
// POTENTIALLY SCROLLABLE in either axis — a box whose own overflow and its parent's in that axis are each neither
// `visible` nor `clip`, the parent's `clip` taken for `hidden` (Chrome and Firefox: none under `html { overflow: clip }`)
// — else none.
pub(crate) fn scrolling_element(engine: &mut StyleEngine, arena: &RealmArena, doc: NodeId, quirks: bool, now: f64) -> Option<NodeId> {
    if !quirks {
        return document_element(arena, doc);
    }
    let body = body_element(arena, doc)?;
    engine.flush(arena, now);
    let style = |id: Option<NodeId>| id.and_then(|id| primary_style(arena, id)).map(|s| overflows(&s));
    let (Some(own), Some(parent)) = (style(Some(body)), style(arena.get(body).and_then(|n| n.parent))) else { return Some(body) };
    let scrollable = |o: Overflow| !matches!(o, Overflow::Visible | Overflow::Clip);
    // (…"has an associated box": rendered, and not `display: contents`, which generates none)
    let has_box = primary_style(arena, body).is_some_and(|s| s.get_box().clone_display() != Display::Contents);
    let potentially_scrollable = has_box
        && rendered(engine, arena, body, true, false, None, now)
        && (0..2).any(|axis| scrollable(own[axis]) && (parent[axis] == Overflow::Clip || scrollable(parent[axis])));
    (!potentially_scrollable).then_some(body)
}

// Whether `id` keeps a scroll offset: its document's scrolling element (in quirks mode or not), whatever the root's own
// overflow says — that PROPAGATES to the viewport, whose offset the root keeps — and any rendered scroll container: a text input,
// or a box that is no non-replaced inline (Chrome refuses the write on a `<span>` whose overflow computes to `auto`, and
// on an `<img>`) and scrolls in an axis by its overflow as propagated. Everything else refuses the write and reads 0:
// `overflow: visible` or `clip`, the body whose overflow went to the viewport, a box `display: none` left out.
pub(crate) fn holds_scroll_offset(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, quirks: bool, now: f64) -> bool {
    let doc = arena.root_of(id);
    if arena.get(doc).is_some_and(|d| d.kind == NodeKind::Document) && scrolling_element(engine, arena, doc, quirks, now) == Some(id) {
        return true;
    }
    let Some(node) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return false };
    let text_input = node.is_html_named("input") && node.input_has(crate::input_types::TEXTUAL);
    if !text_input {
        engine.flush(arena, now);
        let Some(style) = primary_style(arena, id) else { return false };
        if !propagated_overflow(arena, id, &style).into_iter().any(scrolls)
            || style.get_box().walk_display(node.rendering_tag()) == Display::Inline
        {
            return false;
        }
    }
    rendered(engine, arena, id, true, false, None, now)
}

// Where `id`'s scroll offset is KEPT, the box a scroll of it moves: the VIEWPORT's — kept on the document element — for
// its document's scrolling element (the root in standards mode, the body in quirks mode, whose `scrollTop` is the
// viewport's there: Chrome reads 1350 on both `scrollY` and `body.scrollTop` after a `scrollIntoView`), none for the
// root in quirks mode (CSSOM View: its scroll members read 0 and move nothing there, however the body stands), and
// `id`'s own for every other element.
pub(crate) fn scroll_holder(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, quirks: bool, now: f64) -> Option<NodeId> {
    let doc = arena.root_of(id);
    if arena.get(doc).is_none_or(|d| d.kind != NodeKind::Document) {
        return Some(id);
    }
    let root = document_element(arena, doc);
    if scrolling_element(engine, arena, doc, quirks, now) == Some(id) {
        return root;
    }
    (!(quirks && root == Some(id))).then_some(id)
}

// The overflow a box uses once VIEWPORT PROPAGATION is applied (CSS Overflow 3 §3.3): the root's goes to the viewport,
// and the body's too where the root's is `visible` in both axes — each then `visible` on the box itself (Chrome: `body
// { overflow: auto }` neither clips nor keeps an offset, while under `html { overflow: hidden }` the body scrolls).
fn propagated_overflow(arena: &RealmArena, id: NodeId, style: &ComputedValues) -> [Overflow; 2] {
    const VISIBLE: [Overflow; 2] = [Overflow::Visible, Overflow::Visible];
    let doc = arena.root_of(id);
    if arena.get(doc).is_some_and(|d| d.kind == NodeKind::Document) {
        let root = document_element(arena, doc);
        if root == Some(id) {
            return VISIBLE;
        }
        if body_element(arena, doc) == Some(id) && root.and_then(|r| primary_style(arena, r)).is_some_and(|s| overflows(&s) == VISIBLE) {
            return VISIBLE;
        }
    }
    overflows(style)
}

// The box whose padding edge a mouse event's offset is measured from: `id`'s own, or — a non-replaced inline box having
// none — that of the nearest box up the flat tree that is not one (Chrome and Firefox, MouseEvent-prototype-offsetX-
// offsetY: a span's offset is from its container's, an `<img>`'s from its own); an element that generates no box at
// all — `display: contents`, a `<slot>` — passed over on the way, as the layout passes it. A target with no box keeps
// itself, its origin the empty rect's (Chrome: a `display: contents` div's offset is the point's from the viewport's).
pub(crate) fn padding_edge_box(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> NodeId {
    engine.flush(arena, now);
    let mut at = id;
    loop {
        let Some(node) = arena.get(at) else { return at };
        let display = primary_style(arena, at).map(|s| s.get_box().walk_display(node.rendering_tag()));
        let boxless = matches!(display, None | Some(Display::Contents | Display::None));
        if (at == id && boxless) || (!boxless && (display != Some(Display::Inline) || replaced_or_control(arena, at, node))) {
            return at;
        }
        match crate::geometry::flat_parent(arena, at).filter(|&p| arena.get(p).is_some_and(|n| n.kind == NodeKind::Element)) {
            Some(parent) => at = parent,
            None => return at,
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "scrollingElement", scrolling_element_op, context_id);
    crate::dom::register(scope, ns, "scrollMove", scroll_move_op, context_id);
    crate::dom::register(scope, ns, "holdsScrollOffset", holds_scroll_offset_op, context_id);
    crate::dom::register(scope, ns, "scrollHolder", scroll_holder_op, context_id);
    crate::dom::register(scope, ns, "paddingEdgeBox", padding_edge_box_op, context_id);
}

// A box that keeps a scroll offset — the root for the viewport — moved to (x, y), an axis given as None staying, each
// clamped to its scroll range as the scrollTop / scrollLeft setters clamp (one with no range — no box laid out — to 0):
// `scrollTo(0, scrollHeight)` lands at `scrollHeight - clientHeight`, which puts a list's sentinel INSIDE the viewport
// where an IntersectionObserver sees it. Where it moved, its document's pending scroll and scrollend event targets have
// it — the DOCUMENT for its viewport, whose three names (`document`, `documentElement`, `scrollingElement`) are one
// scrolling box — and the scroll generation moves. Whether it moved. The realm laid out first, by the caller.
fn scroll_move(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, id: NodeId, doc: NodeId, to: [Option<f64>; 2]) -> bool {
    let cid = crate::dom::realm_id(scope, args);
    let arena = crate::dom::realm(scope, cid);
    let range = crate::geometry::scroll_range(arena, id);
    let Some(node) = arena.get(id) else { return false };
    let to = [0, 1].map(|axis| to[axis].map(|v| range.map_or(0.0, |r| v.max(r[axis][0]).min(r[axis][1]))));
    if !(0..2).any(|axis| to[axis].is_some_and(|v| v != node.scroll[axis])) {
        return false;
    }
    let viewport = document_element(arena, doc) == Some(id)
        || (arena.document_mode(Some(doc)).0
            && with_engine(scope, args, |engine, arena, now| scrolling_element(engine, arena, doc, true, now) == Some(id)).unwrap_or(false));
    let arena = crate::dom::realm(scope, cid);
    arena.scrolled();
    if let Some(node) = arena.get_mut_quietly(id) {
        for (axis, v) in to.into_iter().enumerate() {
            if let Some(v) = v {
                node.scroll[axis] = v;
            }
        }
        if node.scroll != [0.0; 2] && !arena.scrolled_nodes.contains(&id) {
            arena.scrolled_nodes.push(id);
        }
    }
    let target = if viewport { doc } else { id };
    arena.queue_scroll_event(doc, target, false);
    arena.queue_scroll_event(doc, target, true);
    arena.generations.bump(crate::dom::GEN_SCROLL);
    true
}
// __dom.scrollMove(nid, docNid, x, y) -> whether the box moved (`scroll_move`; an axis not a number stays).
fn scroll_move_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(id), Some(doc)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    let to = [2, 3].map(|i| args.get(i).is_number().then(|| args.get(i).number_value(scope)).flatten());
    let moved = scroll_move(scope, &args, id, doc, to);
    rv.set_bool(moved);
}

// __dom.scrollingElement(docNid) -> [the document's scrolling element] or [] (`scrolling_element`), as
// `nodes_value` answers — in the document's mode (`document_mode`).
fn scrolling_element_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let found = with_engine(scope, &args, |engine, arena, now| {
        let quirks = arena.document_mode(Some(doc)).0;
        scrolling_element(engine, arena, doc, quirks, now)
    })
    .flatten();
    let cid = crate::dom::realm_id(scope, &args);
    rv.set(crate::dom::nodes_value(scope, cid, found.as_slice()));
}

// __dom.holdsScrollOffset(nid, docNid) -> whether the element keeps a scroll offset (`holds_scroll_offset`), in its
// document's mode (`document_mode`).
fn holds_scroll_offset_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let doc = nid_arg(scope, &args, 1);
    let holds = with_engine(scope, &args, |engine, arena, now| {
        let quirks = arena.document_mode(doc).0;
        holds_scroll_offset(engine, arena, id, quirks, now)
    });
    rv.set_bool(holds.unwrap_or(false));
}

// __dom.scrollHolder(nid, docNid) -> [the box whose scroll offset the element's is] or [] (`scroll_holder`), as
// `nodes_value` answers — in its document's mode (`document_mode`).
fn scroll_holder_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let doc = nid_arg(scope, &args, 1);
    let found = with_engine(scope, &args, |engine, arena, now| {
        let quirks = arena.document_mode(doc).0;
        scroll_holder(engine, arena, id, quirks, now)
    })
    .unwrap_or(Some(id));
    let cid = crate::dom::realm_id(scope, &args);
    rv.set(crate::dom::nodes_value(scope, cid, found.as_slice()));
}

// __dom.paddingEdgeBox(nid) -> [the box a mouse event's offset is measured from] (`padding_edge_box`), as
// `nodes_value` answers.
fn padding_edge_box_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let found = with_engine(scope, &args, |engine, arena, now| padding_edge_box(engine, arena, id, now)).unwrap_or(id);
    let cid = crate::dom::realm_id(scope, &args);
    rv.set(crate::dom::nodes_value(scope, cid, &[found]));
}
