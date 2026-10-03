// What of a document is RENDERED, and the text it renders: whether a node is shown at all (the question every visibility
// filter, geometry read and `checkVisibility()` asks), and HTML's rendered text collection — `innerText`, and the visible
// text a driver reads off a node. Both read the style engine's values over the arena; neither lays anything out.

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
use crate::style::{primary_style, StyleEngine};
use crate::walk::WalkDisplay;
use style::properties::ComputedValues;
use style::values::computed::text::TextTransform;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

// Elements no box is ever made for, whatever the page declares.
const INVISIBLE_TAGS: [&str; 6] = ["head", "script", "style", "template", "noscript", "title"];
// Elements whose child content is FALLBACK, shown only by a browser that cannot render the element itself, which this
// one can: their children generate no boxes and contribute no text — the element is all of it, drawing its own bitmap
// or widget (the layout walk lays each out as a leaf: walk.rs `replaced_or_control`). `<object>` joins them only while it
// is not showing its fallback (`renders_object_fallback`).
const FALLBACK_ONLY_TAGS: [&str; 8] = ["canvas", "iframe", "frame", "embed", "video", "audio", "progress", "meter"];
// Block-shaped tags put a required line break either side of their content. A `<td>` / `<th>` is not one: adjacent cells
// are separated by a tab (`<td>A</td><td>B</td>` is "A\tB"), the breaks only where the cell's content holds a block.
const BLOCK_TAGS: [&str; 32] = [
    "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "form", "h1",
    "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
    "tfoot", "thead", "tr",
];
// …and "ul", which the array above has no room for in its fixed size: asked beside it.
const CELL_TAGS: [&str; 2] = ["td", "th"];
// The table structure holds no text: white space between a `<table>` and its rows generates no box, even under
// `white-space: pre` (Chrome: `<table style="white-space:pre">  <td>abc</td>  ` is "abc").
const TABLE_STRUCTURE_TAGS: [&str; 5] = ["table", "tbody", "thead", "tfoot", "tr"];
// An ATOMIC inline is one box of its own, so it does not join the collapsible white space on either side of it into one
// run: `abc <img> def` keeps both spaces (Chrome), where `abc <span></span> def` keeps one.
const ATOMIC_INLINE_TAGS: [&str; 13] =
    ["img", "video", "canvas", "iframe", "embed", "object", "input", "select", "textarea", "button", "audio", "svg", "math"];

fn tag(n: &NodeData) -> &str {
    &n.local_name
}
fn is_block_tag(t: &str) -> bool {
    BLOCK_TAGS.contains(&t) || t == "ul"
}

// …an element whose content is fallback: one of `FALLBACK_ONLY_TAGS`, or an `<object>` not showing its own.
fn has_fallback_only_content(arena: &RealmArena, n: &NodeData) -> bool {
    FALLBACK_ONLY_TAGS.contains(&tag(n)) || (tag(n) == "object" && !renders_object_fallback(arena, n))
}
// An `<object>` with no resource of its own renders its CHILDREN — any element, or text that is not CSS white space (an
// NBSP or an em space is fallback content). A resource this driver never fetches is taken to have loaded.
pub(crate) fn renders_object_fallback(arena: &RealmArena, n: &NodeData) -> bool {
    if n.plain_attr("data").is_some() {
        return false;
    }
    n.children.iter().filter_map(|&c| arena.get(c)).any(|c| {
        c.kind == NodeKind::Element || (c.kind == NodeKind::Text && c.data.iter().any(|&u| !matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C)))
    })
}
// Elements no UA renders, whatever the page declares: a hidden `<input>`, an `<audio>` with no controls, and an `<embed>`
// with no resource — which Chrome gives no box at all while its computed `display` stays `inline`.
fn ua_not_rendered(n: &NodeData) -> bool {
    match tag(n) {
        "input" => n.plain_attr("type").is_some_and(|t| t.eq_ignore_ascii_case("hidden")),
        "audio" => n.plain_attr("controls").is_none(),
        "embed" => n.plain_attr("src").is_none(),
        _ => false,
    }
}

// Is `id` RENDERED — an element of a connected document with a box: no `display: none` up its flat tree (the engine's
// `shown`), no invisible tag, no fallback-content ancestor, no slot that does not take it; with `honour_skips`, not
// SKIPPED either (a closed `<details>`'s content, laid out but `checkVisibility()` false); and unless
// `ignore_visibility`, not hidden by `visibility`. `rendered_at`: a node the caller already reached through rendered
// ancestors, where the walk stops.
pub(crate) fn rendered(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, ignore_visibility: bool, honour_skips: bool, rendered_at: Option<NodeId>, now: f64) -> bool {
    let Some(el) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return false };
    if INVISIBLE_TAGS.contains(&tag(el)) || ua_not_rendered(el) {
        return false;
    }
    let shown = engine.shown(arena, id, now);
    if shown == 0 {
        return false;
    }
    let mut cur = id;
    let mut summary_seen = false;
    let connected = loop {
        if Some(cur) == rendered_at {
            return true;
        }
        let Some(n) = arena.get(cur) else { return false };
        match n.kind {
            NodeKind::Document => break true,
            NodeKind::Element => {
                if INVISIBLE_TAGS.contains(&tag(n)) || (cur != id && has_fallback_only_content(arena, n)) {
                    return false;
                }
                if honour_skips && cur != id && tag(n) == "details" && n.plain_attr("open").is_none() && !summary_seen {
                    return false;
                }
                summary_seen |= tag(n) == "summary";
            }
            _ => {}
        }
        // (…a shadow root goes on at its host, and a generated box at its originating element)
        let Some(p) = n.parent.or(n.host).or(n.generated_of.map(|(origin, _)| origin)) else { break false };
        let pn = arena.get(p);
        // (…and a host's light child up the FLAT tree, through the slot it is assigned to — none, and it renders nowhere)
        if pn.is_some_and(|pn| pn.shadow_root.is_some()) && n.kind == NodeKind::Element && n.generated_of.is_none() {
            match n.assigned_slot.filter(|&s| arena.get(s).is_some()) {
                Some(slot) => cur = slot,
                None => return false,
            }
            continue;
        }
        // (…and a slot's own children are its FALLBACK, rendered only while nothing is assigned to it)
        if pn.is_some_and(|pn| pn.is_html_named("slot") && !pn.assigned.is_empty()) {
            return false;
        }
        cur = p;
    };
    connected && (ignore_visibility || shown != 2)
}

// Does `el` generate a box the rendered-text walk descends? Not an invisible tag, fallback content or one no UA renders;
// shown by the engine and not skipping its contents — whose text renders nothing, not even the breaks around it
// (Chrome: "A||" for `A|<div hidden=until-found>uf</div>|`). `visibility` is the walk's own, per node.
fn generates_text_box(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, n: &NodeData, now: f64) -> bool {
    if INVISIBLE_TAGS.contains(&tag(n)) || has_fallback_only_content(arena, n) || ua_not_rendered(n) {
        return false;
    }
    engine.shown(arena, id, now) != 0 && !engine.skips(arena, id, now)
}

// The `white-space` modes, by the three behaviours the walk asks about.
#[derive(Clone, Copy, PartialEq)]
enum Ws {
    Normal,
    Nowrap,
    Pre,
    PreWrap,
    PreLine,
    BreakSpaces,
}
impl Ws {
    fn preserving(self) -> bool {
        matches!(self, Ws::Pre | Ws::PreWrap | Ws::PreLine | Ws::BreakSpaces)
    }
}
// An element's own `white-space` keyword — None where its longhands make a combination no keyword names, which keeps the
// mode it inherits.
fn own_ws(style: &ComputedValues) -> Option<Ws> {
    use style::computed_values::text_wrap_mode::T as Wrap;
    use style::computed_values::white_space_collapse::T as Collapse;
    let t = style.get_inherited_text();
    Some(match (t.white_space_collapse, t.text_wrap_mode == Wrap::Wrap) {
        (Collapse::Collapse, true) => Ws::Normal,
        (Collapse::Collapse, false) => Ws::Nowrap,
        (Collapse::Preserve, false) => Ws::Pre,
        (Collapse::Preserve, true) => Ws::PreWrap,
        (Collapse::PreserveBreaks, true) => Ws::PreLine,
        (Collapse::BreakSpaces, true) => Ws::BreakSpaces,
        _ => return None,
    })
}
// …and the mode in force AT `id`, up its ancestors.
fn inherited_ws(arena: &RealmArena, id: Option<NodeId>) -> Ws {
    let mut at = id;
    while let Some(n) = at {
        if let Some(ws) = primary_style(arena, n).as_deref().and_then(own_ws) {
            return ws;
        }
        at = arena.get(n).and_then(|d| d.parent);
    }
    Ws::Normal
}
// Does `id`'s `visibility` hide it — its own computed one where the engine styles it, else what it `inherited`?
fn hides_by_visibility(arena: &RealmArena, id: NodeId, inherited: bool) -> bool {
    use style::computed_values::visibility::T as Visibility;
    match primary_style(arena, id) {
        Some(s) => s.get_inherited_box().visibility != Visibility::Visible,
        None => inherited,
    }
}
fn text_transform(arena: &RealmArena, id: Option<NodeId>) -> TextTransform {
    id.and_then(|id| primary_style(arena, id)).map_or(TextTransform::none(), |s| s.get_inherited_text().text_transform)
}
fn apply_transform(text: Vec<u16>, transform: TextTransform) -> Vec<u16> {
    let case = transform & TextTransform::CASE_TRANSFORMS;
    if case.is_empty() || text.is_empty() {
        return text;
    }
    let s = String::from_utf16_lossy(&text);
    let out = if case == TextTransform::UPPERCASE {
        s.to_uppercase()
    } else if case == TextTransform::LOWERCASE {
        s.to_lowercase()
    } else {
        // (…the first character of each word: after the start and after white space)
        let mut out = String::with_capacity(s.len());
        let mut at_word = true;
        for c in s.chars() {
            if at_word && !c.is_whitespace() {
                out.extend(c.to_uppercase());
            } else {
                out.push(c);
            }
            at_word = c.is_whitespace();
        }
        out
    };
    out.encode_utf16().collect()
}

// The rendered text collection's state, which STREAMS across the walk: whether a collapsible space renders depends on
// what was emitted before it, across siblings and across nesting.
struct Walk<'a> {
    engine: &'a mut StyleEngine,
    arena: &'a RealmArena,
    now: f64,
    root: NodeId,
    // Nothing rendered yet: a leading collapsible space is dropped.
    at_start: bool,
    // The last thing rendered was a collapsible space.
    ends_collapsible: bool,
    // A required break comes before whatever is collected next.
    break_pending: bool,
    // Anything at all has been rendered.
    any_rendered: bool,
    // What the last collected node produced beyond its text: whether it is only collapsible white space, and the
    // required line breaks it ended owing its parent.
    last_collapsible_only: bool,
    last_owed: u32,
    // Whether a host's light child renders, and hidden, per slot: 0 not rendered, 1 visible, 2 visibility-hidden.
    slots: std::collections::HashMap<NodeId, u8>,
}

const SPACE: u16 = 0x20;
const NEWLINE: u16 = 0x0A;
fn is_collapsible_ws(u: u16) -> bool {
    matches!(u, 0x20 | 0x09 | 0x0A | 0x0D)
}
fn is_js_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(char::is_whitespace) || u == 0xFEFF
}

impl Walk<'_> {
    // A node's rendered text (`collectText`). `hidden`: whether THIS node's `visibility` hides it — a hidden node
    // contributes its CHILDREN's items and nothing of its own: no text, no `<br>` newline, no required breaks.
    fn collect(&mut self, id: NodeId, transform: TextTransform, ws: Ws, hidden: bool) -> Vec<u16> {
        self.last_collapsible_only = true;
        self.last_owed = 0;
        let arena = self.arena;
        let Some(node) = arena.get(id) else { return Vec::new() };
        if node.kind == NodeKind::Text {
            return if hidden { Vec::new() } else { self.text(&node.data, transform, ws) };
        }
        if !matches!(node.kind, NodeKind::Element | NodeKind::Document | NodeKind::Fragment) {
            return Vec::new();
        }
        let (mut transform, mut ws) = (transform, ws);
        if node.kind == NodeKind::Element {
            if !generates_text_box(self.engine, arena, id, node, self.now) {
                return Vec::new();
            }
            // (…a textarea's content is its VALUE, no rendered text of an ancestor's — asked about itself, it is)
            if tag(node) == "textarea" && id != self.root {
                return Vec::new();
            }
            if tag(node) == "br" {
                // (…a `display: contents` one is no break: `aa<br>bb` is one line)
                if id == self.root || hidden || !generates_box(arena, id) {
                    return Vec::new();
                }
                self.last_collapsible_only = false;
                self.any_rendered = true;
                return vec![NEWLINE];
            }
            let style = primary_style(arena, id);
            if let Some(s) = &style {
                transform = s.get_inherited_text().text_transform;
                ws = own_ws(s).unwrap_or(ws);
            }
            if tag(node) == "details" && node.plain_attr("open").is_none() {
                // (…a closed one renders its `<summary>` alone)
                let mut out = Vec::new();
                for &c in &node.children {
                    if arena.get(c).is_some_and(|c| c.kind == NodeKind::Element && tag(c) == "summary") {
                        let h = hides_by_visibility(arena, c, hidden);
                        out.extend(self.collect(c, transform, ws, h));
                    }
                }
                return out;
            }
        }
        let flex_context = node.kind == NodeKind::Element && primary_style(arena, id).is_some_and(|s| {
            matches!(s.get_box().clone_display().inside(), DisplayInside::Flex | DisplayInside::Grid)
        });
        let host_root = node.shadow_root.filter(|_| node.kind == NodeKind::Element);
        let mut out: Vec<u16> = Vec::new();
        // Required line breaks are PENDING until something is written after them: they merge (consecutive
        // requirements collapse to the largest), and collapsible white space next to one renders nothing.
        let mut pending = 0u32;
        let mut collapsible_only = true;
        for &c in &node.children {
            let Some(cn) = arena.get(c) else { continue };
            let mut inherited = hidden;
            // (…a HOST renders its light children only through the slots they are assigned to)
            if let Some(root) = host_root {
                let state = cn.assigned_slot.map_or(0, |slot| self.slot_state(slot, root, hidden));
                if state == 0 {
                    continue;
                }
                inherited = state == 2;
            }
            let ws_only = cn.kind == NodeKind::Text && cn.data.iter().all(|&u| is_js_space(u));
            // (…no anonymous flex item is made for white space between items, and the table structure holds none — text the
            // DOM put there that is not white space is wrapped in an anonymous cell and renders)
            if ws_only && (flex_context || (node.kind == NodeKind::Element && TABLE_STRUCTURE_TAGS.contains(&tag(node)))) {
                continue;
            }
            let space_before = self.ends_collapsible;
            // (…a required break SEPARATES: with nothing rendered in front of it there is nothing to separate)
            let rendered_before = self.any_rendered;
            if pending > 0 {
                self.break_pending = true;
            }
            let is_element = cn.kind == NodeKind::Element;
            let c_hidden = if is_element { hides_by_visibility(arena, c, inherited) } else { inherited };
            let part = self.collect(c, transform, ws, c_hidden);
            let part_collapsible = self.last_collapsible_only;
            let part_ends_collapsible = self.ends_collapsible;
            let is_cell = is_element && CELL_TAGS.contains(&tag(cn));
            // (…an atomic inline separates the white space around it, though it contributes no text)
            if is_element && ATOMIC_INLINE_TAGS.contains(&tag(cn)) && generates_text_box(self.engine, arena, c, cn, self.now) {
                self.ends_collapsible = false;
                self.at_start = false;
                self.break_pending = false;
            }
            // (…a cell whose content holds a block acts as one at the row's level: breaks before AND after it)
            let cell_with_block = is_cell && self.last_owed > 0;
            // (…and a `<br>` that is no line break — block-level, floated, absolutely positioned — is a block)
            let is_block = is_element
                && !c_hidden
                && (is_block_tag(tag(cn)) || flex_context || cell_with_block || (tag(cn) == "br" && generates_box(arena, c) && !is_line_break(arena, c)));
            // (…a block that renders contributes its breaks even with no text — `abc<div></div>def` — but a shadow HOST,
            // whose tree this walk does not descend, has nothing to put between them)
            if part.is_empty() && !is_cell && !(is_block && cn.shadow_root.is_none() && generates_text_box(self.engine, arena, c, cn, self.now)) {
                continue;
            }
            // (…a `<p>` asks for TWO breaks whatever its display, and a cell passes on what its content asked for)
            let breaks = if is_element && tag(cn) == "p" { 2 } else if is_cell { self.last_owed.max(1) } else { 1 };
            if is_block && !out.is_empty() {
                pending = pending.max(breaks);
            }
            if !part.is_empty() && !(pending > 0 && part_collapsible) {
                if pending > 0 {
                    if space_before && out.last() == Some(&SPACE) {
                        out.pop();
                    }
                    if rendered_before {
                        out.extend(std::iter::repeat_n(NEWLINE, pending as usize));
                        self.ends_collapsible = true;
                        self.any_rendered = true;
                    }
                    pending = 0;
                    self.at_start = false;
                    self.break_pending = false;
                } else if space_before && !part_collapsible && part.first() == Some(&NEWLINE) && out.last() == Some(&SPACE) {
                    // (…a `<br>` ends a line, and the collapsible space before it renders nothing)
                    out.pop();
                }
                out.extend_from_slice(&part);
                self.ends_collapsible = part_ends_collapsible;
                if part.last() == Some(&NEWLINE) {
                    self.ends_collapsible = true;
                    self.break_pending = false;
                }
                if !part_collapsible {
                    collapsible_only = false;
                }
            }
            if is_block {
                pending = pending.max(breaks);
            }
            // (…and cells are separated by a tab; a hidden one adds its children's items and no separator)
            if is_cell && !c_hidden && has_next_cell(arena, node, c) {
                if pending > 0 {
                    if space_before && out.last() == Some(&SPACE) {
                        out.pop();
                    }
                    if rendered_before {
                        out.extend(std::iter::repeat_n(NEWLINE, pending as usize));
                    }
                    pending = 0;
                    self.at_start = false;
                    self.break_pending = false;
                }
                out.push(0x09);
                self.any_rendered = true;
                self.ends_collapsible = false;
                collapsible_only = false;
            }
        }
        self.last_collapsible_only = collapsible_only;
        // (…a trailing required break is NOT written: this element's block-ness is the PARENT's business)
        self.last_owed = pending;
        out
    }

    // A text node's contribution: CSS white-space processing per node, streaming across nodes.
    fn text(&mut self, data: &[u16], transform: TextTransform, ws: Ws) -> Vec<u16> {
        let preserving = ws.preserving();
        let collapses_spaces = !preserving || ws == Ws::PreLine;
        let raw: Vec<u16> = match ws {
            // (`pre-line` collapses spaces and tabs and keeps its newlines; a space beside one goes with it)
            Ws::PreLine => {
                let mut out: Vec<u16> = Vec::with_capacity(data.len());
                for &u in data {
                    if matches!(u, 0x20 | 0x09 | 0x0C) {
                        if out.last() != Some(&SPACE) {
                            out.push(SPACE);
                        }
                    } else if u == NEWLINE {
                        if out.last() == Some(&SPACE) {
                            out.pop();
                        }
                        out.push(NEWLINE);
                    } else if out.last() == Some(&SPACE) && out.len() >= 2 && out[out.len() - 2] == NEWLINE {
                        out.pop();
                        out.push(u);
                    } else {
                        out.push(u);
                    }
                }
                // (…and a space right after a newline at the end too)
                if out.last() == Some(&SPACE) && out.len() >= 2 && out[out.len() - 2] == NEWLINE {
                    out.pop();
                }
                out
            }
            _ if preserving => data.to_vec(),
            _ => {
                let mut out: Vec<u16> = Vec::with_capacity(data.len());
                for &u in data {
                    if is_collapsible_ws(u) {
                        if out.last() != Some(&SPACE) {
                            out.push(SPACE);
                        }
                    } else {
                        out.push(u);
                    }
                }
                out
            }
        };
        let mut text = apply_transform(raw, transform);
        // (…the run that CROSSES nodes: a collapsible space renders nothing after one, after a break, or before anything)
        if collapses_spaces && text.first() == Some(&SPACE) && (self.at_start || self.ends_collapsible || self.break_pending) {
            text.remove(0);
        }
        self.last_collapsible_only = collapses_spaces
            && text.iter().all(|&u| matches!(u, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C))
            && !(preserving && text.contains(&NEWLINE));
        if !text.is_empty() {
            self.at_start = false;
            self.break_pending = false;
            if !self.last_collapsible_only {
                self.any_rendered = true;
            }
            self.ends_collapsible = collapses_spaces && text.last() == Some(&SPACE);
        }
        text
    }

    // Whether a host's light child assigned to `slot` renders (0 no; 1 visible; 2 visibility-hidden): the slot asked as far
    // as its shadow root, once per walk, its `visibility` from the HOST's down the shadow-side ancestors to it.
    fn slot_state(&mut self, slot: NodeId, root: NodeId, host_hidden: bool) -> u8 {
        if let Some(&v) = self.slots.get(&slot) {
            return v;
        }
        let v = if !rendered(self.engine, self.arena, slot, true, false, Some(root), self.now) {
            0
        } else {
            let host = self.arena.get(root).and_then(|r| r.host);
            let mut chain = Vec::new();
            let mut at = Some(slot);
            while let Some(n) = at.filter(|&n| Some(n) != host) {
                chain.push(n);
                at = crate::geometry::flat_parent(self.arena, n);
            }
            let hidden = chain.iter().rev().fold(host_hidden, |h, &n| hides_by_visibility(self.arena, n, h));
            if hidden { 2 } else { 1 }
        };
        self.slots.insert(slot, v);
        v
    }
}

// Does `id` generate a box — anything but `display: contents`?
fn generates_box(arena: &RealmArena, id: NodeId) -> bool {
    !primary_style(arena, id).is_some_and(|s| s.get_box().clone_display().is_contents())
}
// Is `id` a `<br>` that BREAKS a line — an inline-level one, or a flex or grid item — rather than a block like any other
// (block-level, floated or absolutely positioned)?
fn is_line_break(arena: &RealmArena, id: NodeId) -> bool {
    use style::computed_values::position::T as Position;
    let Some(style) = primary_style(arena, id) else { return false };
    let d = style.get_box().clone_display();
    if d.is_none() || d.is_contents() || matches!(style.get_box().clone_position(), Position::Absolute | Position::Fixed) {
        return false;
    }
    if matches!(d.outside(), DisplayOutside::Inline) {
        return true;
    }
    let mut p = crate::geometry::flat_parent(arena, id);
    while let Some(at) = p.filter(|&at| primary_style(arena, at).is_some_and(|s| s.get_box().clone_display().is_contents())) {
        p = crate::geometry::flat_parent(arena, at);
    }
    p.and_then(|p| primary_style(arena, p)).is_some_and(|s| matches!(s.get_box().clone_display().inside(), DisplayInside::Flex | DisplayInside::Grid))
}
fn has_next_cell(arena: &RealmArena, parent: &NodeData, cell: NodeId) -> bool {
    parent.children.iter().skip_while(|&&c| c != cell).skip(1).any(|&c| arena.get(c).is_some_and(|n| n.kind == NodeKind::Element && CELL_TAGS.contains(&tag(n))))
}

// The VISIBLE text of `id` a driver reads (WebDriver's getText): none for a node not rendered or skipped, a textarea's
// value, else the rendered text collection from `id` under what its parent hands down — its `text-transform`, its
// `white-space` mode and its `visibility`.
pub(crate) fn visible_text(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> Vec<u16> {
    let Some(node) = arena.get(id) else { return Vec::new() };
    let el = if node.kind == NodeKind::Element { Some(id) } else { node.parent };
    if el.and_then(|e| arena.get(e)).is_some_and(|e| e.kind == NodeKind::Element) && !rendered(engine, arena, el.unwrap_or(id), true, true, None, now) {
        return Vec::new();
    }
    if node.kind == NodeKind::Element && tag(node) == "textarea" {
        return arena.raw_value(node).encode_utf16().collect();
    }
    let parent = node.parent.filter(|&p| arena.get(p).is_some_and(|n| n.kind == NodeKind::Element));
    let above = parent.is_some_and(|p| hides_by_visibility(arena, p, false));
    let hidden = if node.kind == NodeKind::Element { hides_by_visibility(arena, id, above) } else { above };
    let mut walk = Walk {
        engine,
        arena,
        now,
        root: id,
        at_start: true,
        ends_collapsible: false,
        break_pending: false,
        any_rendered: false,
        last_collapsible_only: true,
        last_owed: 0,
        slots: std::collections::HashMap::new(),
    };
    let mut out = walk.collect(id, text_transform(arena, parent), inherited_ws(arena, parent), hidden);
    // (…a collapsible space at the very END renders nothing either)
    if walk.ends_collapsible && out.last() == Some(&SPACE) {
        out.pop();
    }
    out
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "rendered", rendered_op, context_id);
    crate::dom::register(scope, ns, "visibleText", visible_text_op, context_id);
    crate::dom::register(scope, ns, "boxKind", box_kind_op, context_id);
}

// What box `id` generates by its own computed style, which says so before anything is laid out: `BOX_NONE` none — a
// `display: none` or `display: contents` element, or one with no style — `BOX_INLINE` a non-replaced inline box, which
// has no client box, and `BOX_OTHER` any other.
const BOX_NONE: i32 = 0;
const BOX_INLINE: i32 = 1;
const BOX_OTHER: i32 = 2;
fn box_kind(arena: &RealmArena, id: NodeId) -> i32 {
    let (Some(style), Some(n)) = (crate::geometry::box_style(arena, id), arena.get(id)) else { return BOX_NONE };
    let d = style.get_box().walk_display(n.rendering_tag());
    if d.is_none() || d.is_contents() {
        BOX_NONE
    } else if crate::geometry::inline_by_display(arena, id, &style) {
        BOX_INLINE
    } else {
        BOX_OTHER
    }
}

// One question asked of the realm's arena and its style engine at the page's clock `now`: what it answers, or nothing
// where the realm has no engine or the engine failed a verification (thrown here).
fn with_engine<R>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, now_at: i32, ask: impl FnOnce(&mut StyleEngine, &RealmArena, f64) -> R) -> Option<R> {
    let cid = crate::dom::realm_id(scope, args);
    let now = crate::dom::clock_arg(scope, args, now_at);
    let mut answer = None;
    crate::dom::style_op(scope, cid, |scope| {
        let d = crate::dom::dom(scope);
        let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.realms.get(&cid)) else { return };
        let out = ask(engine, arena, now);
        let failures = engine.take_verify_failures();
        if !crate::dom::threw_verify_failures(scope, failures) {
            answer = Some(out);
        }
    });
    answer
}

// __dom.rendered(nid, ignoreVisibility, honourSkips, now) -> whether the element is rendered (`rendered`); undefined
// where the realm has no engine.
fn rendered_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let [ignore_visibility, honour_skips] = [args.get(1).is_true(), args.get(2).is_true()];
    if let Some(r) = with_engine(scope, &args, 3, |engine, arena, now| rendered(engine, arena, id, ignore_visibility, honour_skips, None, now)) {
        rv.set_bool(r);
    }
}

// __dom.visibleText(nid, now) -> the node's visible text (`visible_text`); undefined where the realm has no engine.
fn visible_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    if let Some(text) = with_engine(scope, &args, 1, |engine, arena, now| visible_text(engine, arena, id, now)) {
        let s = v8::String::new_from_two_byte(scope, &text, v8::NewStringType::Normal).unwrap();
        rv.set(s.into());
    }
}

// __dom.boxKind(nid, now) -> what box the element generates by its own style (`box_kind`); undefined where the realm has
// no engine.
fn box_kind_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    if let Some(kind) = with_engine(scope, &args, 1, |engine, arena, now| {
        engine.flush(arena, now);
        box_kind(arena, id)
    }) {
        rv.set_int32(kind);
    }
}
