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

// The input types that edit text, whose box — the inner editor — scrolls whatever the input's own `overflow` computes to
// (Chrome computes `clip` for one and still takes `input.scrollLeft = 30`).
const NON_TEXT_INPUT_TYPES: [&str; 10] = ["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color", "hidden"];

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
    let text_input = node.is_html_named("input")
        && !node.plain_attr("type").is_some_and(|t| NON_TEXT_INPUT_TYPES.iter().any(|n| t.eq_ignore_ascii_case(n)));
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
// all — `display: contents`, a `<slot>` — passed over on the way, as the layout passes it.
pub(crate) fn padding_edge_box(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> NodeId {
    engine.flush(arena, now);
    let mut at = id;
    loop {
        let Some(node) = arena.get(at) else { return at };
        let display = primary_style(arena, at).map(|s| s.get_box().walk_display(node.rendering_tag()));
        let boxless = matches!(display, None | Some(Display::Contents | Display::None));
        if !boxless && (display != Some(Display::Inline) || replaced_or_control(arena, at, node)) {
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
    crate::dom::register(scope, ns, "holdsScrollOffset", holds_scroll_offset_op, context_id);
    crate::dom::register(scope, ns, "paddingEdgeBox", padding_edge_box_op, context_id);
}

// __dom.scrollingElement(docNid, quirks, now) -> [the document's scrolling element] or [] (`scrolling_element`), as
// `nodes_value` answers.
fn scrolling_element_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let quirks = args.get(1).is_true();
    let found = with_engine(scope, &args, 2, |engine, arena, now| scrolling_element(engine, arena, doc, quirks, now)).flatten();
    let cid = crate::dom::realm_id(scope, &args);
    rv.set(crate::dom::nodes_value(scope, cid, doc, found.as_slice()));
}

// __dom.holdsScrollOffset(nid, quirks, now) -> whether the element keeps a scroll offset (`holds_scroll_offset`), its
// document in quirks mode or not.
fn holds_scroll_offset_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let quirks = args.get(1).is_true();
    let holds = with_engine(scope, &args, 2, |engine, arena, now| holds_scroll_offset(engine, arena, id, quirks, now));
    rv.set_bool(holds.unwrap_or(false));
}

// __dom.paddingEdgeBox(nid, now) -> [the box a mouse event's offset is measured from] (`padding_edge_box`), as
// `nodes_value` answers.
fn padding_edge_box_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let found = with_engine(scope, &args, 1, |engine, arena, now| padding_edge_box(engine, arena, id, now)).unwrap_or(id);
    let cid = crate::dom::realm_id(scope, &args);
    let root = crate::dom::realm(scope, cid).shadow_including_root(id);
    rv.set(crate::dom::nodes_value(scope, cid, root, &[found]));
}
