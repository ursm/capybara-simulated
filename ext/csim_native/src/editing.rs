// What `document.execCommand`'s editing commands act on, in an editing host (dom-nodes.js `_execCommand` makes the
// edits): the block holding the selection — a block container's nearest element at or above where it starts, within
// the host — the list item it is in, an ancestor of a kind, and the text a selection covers, as runs of text nodes with
// the slices of them inside it. Each walk is the engine's; the DOM edits the bindings make from the answers run the
// page's reactions.
//
// And what the engine's own edits — deleting and inserting (editing_delete.rs, editing_insert.rs) — share: the block,
// the table cell and the non-editable island a place is in; what a line holds and where it ends; the nodes the engine
// makes; and the white space an edit brings together rebalanced as the line shows it (`rebalance_space`).

use crate::dom::{nid_arg, realm, NodeData, NodeId, NodeKind, RealmArena};

// The elements the list, indent and justify commands treat as the BLOCK holding the selection.
const BLOCK_CONTAINER_TAGS: [&str; 20] = [
    "p", "div", "section", "article", "aside", "header", "footer", "nav", "main", "blockquote", "pre", "figure", "figcaption", "h1", "h2",
    "h3", "h4", "h5", "h6", "li",
];

// (…by its local name, ASCII-lowercased, in any namespace: the tag the commands always compared)
fn tag_is(arena: &RealmArena, id: NodeId, accept: &dyn Fn(&str) -> bool) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && accept(&n.local_name.to_ascii_lowercase()))
}
fn is_block_container(arena: &RealmArena, id: NodeId) -> bool {
    tag_is(arena, id, &|t| BLOCK_CONTAINER_TAGS.contains(&t))
}

impl RealmArena {
    // Where a command starts from: `node` where the host holds it (or is it), else the host — a selection outside the
    // host never sends a walk past it.
    fn edit_anchor(&self, host: NodeId, node: NodeId) -> NodeId {
        if crate::ranges::contains(self, host, node) { node } else { host }
    }

    // The nearest element at or above `from` (the anchor of the selection's start, entering the child at `offset`
    // where it is an element with children, with `descend`) whose tag `pick` takes — the host itself never.
    fn edit_ancestor(&self, host: NodeId, from: NodeId, offset: u32, descend: bool, pick: &dyn Fn(NodeId) -> bool) -> Option<NodeId> {
        let mut at = self.edit_anchor(host, from);
        if descend {
            if let Some(n) = self.get(at).filter(|n| n.kind == NodeKind::Element && !n.children.is_empty()) {
                at = n.children[(offset as usize).min(n.children.len() - 1)];
            }
        }
        let mut cur = Some(at);
        while let Some(id) = cur.filter(|&c| c != host) {
            if pick(id) {
                return Some(id);
            }
            cur = self.parent_of(id);
        }
        None
    }

    // The text the range `start`..`end` covers: each text node it holds any of, in tree order, with the slice of it
    // inside — a single text node's own slice; one wholly inside, the whole of it; a boundary one, from or to its offset.
    // None empty.
    pub(crate) fn covered_text(&self, (sc, so): (NodeId, u32), (ec, eo): (NodeId, u32)) -> Vec<(NodeId, u32, u32)> {
        let len = |id: NodeId| self.get(id).map_or(0, |n| n.data.len() as u32);
        let is_text = |id: NodeId| self.get(id).is_some_and(|n| n.kind == NodeKind::Text);
        if sc == ec && is_text(sc) {
            return if so < eo { vec![(sc, so, eo)] } else { Vec::new() };
        }
        let common = crate::ranges::common_ancestor(self, sc, ec);
        let before_or_at = |a: (NodeId, u32), b: (NodeId, u32)| crate::ranges::compare_points(self, a, b).is_some_and(|o| o != std::cmp::Ordering::Greater);
        let mut out = Vec::new();
        let mut stack = vec![common];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            stack.extend(n.children.iter().rev());
            let l = len(id);
            if !is_text(id) || l == 0 {
                continue;
            }
            let (a, b) = (if id == sc { so } else { 0 }, if id == ec { eo } else { l });
            let inside = id == sc || id == ec || (before_or_at((sc, so), (id, 0)) && before_or_at((id, l), (ec, eo)));
            if inside && a < b {
                out.push((id, a, b));
            }
        }
        out
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editAncestor", edit_ancestor_op, context_id);
    crate::dom::register(scope, ns, "editCoveredText", edit_covered_text_op, context_id);
}

// The kinds of ancestor `editAncestor` looks for.
const BLOCK: i32 = 0;
const LIST_ITEM: i32 = 1;
const BLOCKQUOTE: i32 = 2;

// __dom.editAncestor(hostNid, nodeNid, offset, descend, kind) -> [the element] or [] (`edit_ancestor`): of kind 0 a
// block container, 1 a list item in an `<ol>` / `<ul>`, 2 a `<blockquote>`, as `nodes_value` answers.
fn edit_ancestor_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(node)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let offset = args.get(2).uint32_value(scope).unwrap_or(0);
    let descend = args.get(3).is_true();
    let kind = args.get(4).int32_value(scope).unwrap_or(BLOCK);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let found = arena.edit_ancestor(host, node, offset, descend, &|id| match kind {
        LIST_ITEM => tag_is(arena, id, &|t| t == "li") && arena.parent_of(id).is_some_and(|p| tag_is(arena, p, &|t| t == "ol" || t == "ul")),
        BLOCKQUOTE => tag_is(arena, id, &|t| t == "blockquote"),
        _ => is_block_container(arena, id),
    });
    rv.set(crate::dom::nodes_value(scope, cid, found.as_slice()));
}

// __dom.editCoveredText(startNid, startOffset, endNid, endOffset) -> [nodes, slices] (`covered_text`): the text nodes,
// as `nodes_value` answers them, and a Float64Array of their slices, `[from, to]` each.
fn edit_covered_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return };
    let so = args.get(1).uint32_value(scope).unwrap_or(0);
    let eo = args.get(3).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let runs = arena.covered_text((sc, so), (ec, eo));
    let nodes: Vec<NodeId> = runs.iter().map(|r| r.0).collect();
    let slices: Vec<f64> = runs.iter().flat_map(|r| [f64::from(r.1), f64::from(r.2)]).collect();
    let nodes_value = crate::dom::nodes_value(scope, cid, &nodes);
    let slices_value = crate::dom::f64_array(scope, &slices).into();
    rv.set(v8::Array::new_with_elements(scope, &[nodes_value, slices_value]).into());
}

#[cfg(test)]
mod tests {
    use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
    use web_atoms::ns;

    fn element(arena: &mut RealmArena, parent: Option<NodeId>, name: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        arena.create(n, parent)
    }
    fn text(arena: &mut RealmArena, parent: NodeId, data: &str) -> NodeId {
        arena.create(NodeData::of_kind(NodeKind::Text, data.encode_utf16().collect()), Some(parent))
    }

    #[test]
    fn covered_text_and_blocks() {
        let mut arena = RealmArena::default();
        let host = element(&mut arena, None, "div");
        let p = element(&mut arena, Some(host), "p");
        let a = text(&mut arena, p, "hello ");
        let b = element(&mut arena, Some(p), "b");
        let w = text(&mut arena, b, "world");
        let q = element(&mut arena, Some(host), "p");
        let t = text(&mut arena, q, "tail");
        assert_eq!(arena.covered_text((a, 2), (w, 3)), vec![(a, 2, 6), (w, 0, 3)]);
        assert_eq!(arena.covered_text((p, 0), (t, 2)), vec![(a, 0, 6), (w, 0, 5), (t, 0, 2)]);
        assert_eq!(arena.covered_text((a, 3), (a, 3)), vec![]);
        let block = |id| crate::editing::is_block_container(&arena, id);
        assert_eq!(arena.edit_ancestor(host, w, 0, false, &block), Some(p));
        assert_eq!(arena.edit_ancestor(host, host, 1, true, &block), Some(q));
        assert_eq!(arena.edit_ancestor(host, host, 0, false, &block), None);
    }
}

// The elements HTML's rendering lays out as blocks — `display: block`, `list-item`, a table — anything else, an unknown
// or custom element too, inline: what an element the engine made, which nothing has styled yet, is taken for.
const BLOCK_TAGS: [&str; 52] = [
    "address", "article", "aside", "blockquote", "body", "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
    "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
    "hr", "html", "legend", "li", "listing", "main", "menu", "nav", "ol", "p", "plaintext", "pre", "search", "section", "summary",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
];
// Whether `id` is laid out inline — by its computed style, or, where it has none yet (one an edit made), by its name.
pub(crate) fn inline_level(arena: &RealmArena, id: NodeId) -> Option<bool> {
    crate::rendered::is_inline_level(arena, id).or_else(|| {
        arena.get(id).filter(|n| n.kind == NodeKind::Element).map(|n| !(n.ns == web_atoms::ns!(html) && BLOCK_TAGS.contains(&&*n.local_name)))
    })
}
// The editing host around `node`: the one it is in, or the one holding the non-editable island it is in.
fn host_around(arena: &RealmArena, node: NodeId) -> Option<NodeId> {
    let mut at = if arena.is_element(node) { Some(node) } else { arena.parent_of(node) };
    while let Some(n) = at.filter(|&n| arena.is_element(n)) {
        if let Some(host) = arena.editing_host(n) {
            return Some(host);
        }
        at = arena.parent_of(n);
    }
    None
}
// The editing host a selection from `start` to `end` edits, and its ends in it: a caret's host, none where it is in a
// non-editable island; a range's start's (else its end's), an end outside it at its edge, one in a non-editable island
// in it out of the island — the start after it, the end before it; none where both are in one island (Chrome: `a[<span contenteditable=false>X]Y</span>b`,
// typed over, is `x<span contenteditable=false>XY</span>b`).
#[allow(clippy::type_complexity)]
pub(crate) fn selection_host(arena: &RealmArena, start: (NodeId, u32), end: (NodeId, u32)) -> Option<(NodeId, ((NodeId, u32), (NodeId, u32)))> {
    if start == end {
        let host = arena.editing_host(if arena.is_element(start.0) { start.0 } else { arena.parent_of(start.0)? })?;
        return Some((host, (start, end)));
    }
    let host = host_around(arena, start.0).or_else(|| host_around(arena, end.0))?;
    let clamp = |(node, offset): (NodeId, u32), after: bool| -> Option<(NodeId, u32)> {
        if !within(arena, host, node) {
            return Some(if after { (host, 0) } else { (host, arena.get(host)?.children.len() as u32) });
        }
        Some(match island_of(arena, node, host) {
            Some(island) => (arena.parent_of(island)?, arena.child_index(island) as u32 + after as u32),
            None => (node, offset),
        })
    };
    let (start, end) = (clamp(start, true)?, clamp(end, false)?);
    // (…none where both ends were in one island)
    (crate::ranges::compare_points(arena, start, end)? != std::cmp::Ordering::Greater).then_some((host, (start, end)))
}
// The block a place in `node` is in: its nearest inclusive ancestor that is no inline — a block, a table's part, a list
// item — or `host`, at most.
pub(crate) fn block_of(arena: &RealmArena, node: NodeId, host: NodeId) -> NodeId {
    let mut at = if arena.is_element(node) { node } else { arena.parent_of(node).unwrap_or(node) };
    while at != host && inline_level(arena, at) != Some(false) {
        match arena.parent_of(at) {
            Some(p) => at = p,
            None => break,
        }
    }
    at
}
// …the table cell (or caption) it is in, below `host` — or `host`: what a deletion never joins across.
pub(crate) fn cell_of(arena: &RealmArena, node: NodeId, host: NodeId) -> NodeId {
    let mut at = Some(node);
    while let Some(n) = at.filter(|&n| n != host) {
        if arena.get(n).is_some_and(|d| d.is_html_named("td") || d.is_html_named("th") || d.is_html_named("caption")) {
            return n;
        }
        at = arena.parent_of(n);
    }
    host
}
// …whether an element is a table's own — the table or a part of its structure — which no join moves content into or out
// of.
pub(crate) fn table_part(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| ["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"].iter().any(|t| n.is_html_named(t)))
}
// …and the outermost element `node` is in, below `host`, that its editing does not reach (`contenteditable=false`): an
// island a deletion takes whole.
pub(crate) fn island_of(arena: &RealmArena, node: NodeId, host: NodeId) -> Option<NodeId> {
    let mut island = None;
    let mut at = Some(node);
    while let Some(n) = at.filter(|&n| n != host) {
        if arena.is_element(n) && arena.editing_host(n).is_none() {
            island = Some(n);
        }
        at = arena.parent_of(n);
    }
    island
}
// Whether `node` is `root` or in it.
pub(crate) fn within(arena: &RealmArena, root: NodeId, node: NodeId) -> bool {
    let mut at = Some(node);
    while let Some(n) = at {
        if n == root {
            return true;
        }
        at = arena.parent_of(n);
    }
    false
}
// Whether `id` is content on a line: text, or an inline element other than a `<br>`.
pub(crate) fn inline_content(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Text || (n.kind == NodeKind::Element && !n.is_html_named("br") && inline_level(arena, id) != Some(false)))
}
// Whether `id` is text of white space alone — what a line shows nothing of between blocks.
pub(crate) fn blank(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Text && n.data.iter().all(|&c| matches!(c, 0x20 | 0x09 | 0x0A | 0x0C | 0x0D)))
}

// What a line meets at an edge: more of its content, a `<br>` that ends it, or the edge of its block.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Edge {
    Content,
    Br,
    Block,
}
// What the line meets going on (`forward`) — or back — from the place before `child` in `parent` (none: its end), past
// empty text and into and out of inline elements: a block's edge where it climbs out of one, or an editing host.
pub(crate) fn edge(arena: &RealmArena, parent: NodeId, child: Option<NodeId>, forward: bool) -> Edge {
    let first = |p: NodeId| arena.get(p).and_then(|n| if forward { n.children.first() } else { n.children.last() }.copied());
    let (mut parent, mut next) = (parent, if forward { child } else { child.map_or_else(|| first(parent), |c| arena.sibling(c, -1)) });
    loop {
        let Some(at) = next else {
            // (…out of an inline element, on; out of anything else, at the line's edge)
            match arena.parent_of(parent) {
                Some(up) if inline_level(arena, parent) == Some(true) && arena.editing_host(parent) != Some(parent) => {
                    next = arena.sibling(parent, if forward { 1 } else { -1 });
                    parent = up;
                    continue;
                }
                _ => return Edge::Block,
            }
        };
        let Some(n) = arena.get(at) else { return Edge::Block };
        match n.kind {
            NodeKind::Text if n.data.is_empty() => next = arena.sibling(at, if forward { 1 } else { -1 }),
            NodeKind::Text => return Edge::Content,
            NodeKind::Element if n.is_html_named("br") => return Edge::Br,
            NodeKind::Element if inline_level(arena, at) == Some(false) => return Edge::Block,
            NodeKind::Element if crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name) || crate::rendered::is_atomic_inline(arena, at) => return Edge::Content,
            NodeKind::Element => {
                parent = at;
                next = first(at);
            }
            _ => next = arena.sibling(at, if forward { 1 } else { -1 }),
        }
    }
}
// …from `node`'s edge on that side.
pub(crate) fn line_edge(arena: &RealmArena, node: NodeId, forward: bool) -> Edge {
    match arena.parent_of(node) {
        Some(parent) => edge(arena, parent, if forward { arena.sibling(node, 1) } else { Some(node) }, forward),
        None => Edge::Block,
    }
}
// Whether `id` holds something a line shows: text, or a void element or an atom other than a `<br>`.
pub(crate) fn has_content(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| match n.kind {
        NodeKind::Text => !n.data.is_empty(),
        NodeKind::Element if n.is_html_named("br") => false,
        NodeKind::Element if crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name) => true,
        _ => n.children.iter().any(|&c| has_content(arena, c)),
    })
}

// The white space around the code units `from` to `to` of the text `node` — and what they hold — rebalanced as Chrome
// does after an edit, where white space collapses: each run of spaces and no-break spaces, a single space between
// content a space, any other alternating no-break space and space, a no-break space first, and — where it ends the line —
// last; one that starts the line a no-break space first too (`a&nbsp; b`, `a&nbsp; &nbsp;b`, `ab&nbsp;&nbsp;`).
pub(crate) fn rebalance_space(scope: &mut v8::PinScope<'_, '_>, caller: i32, node: NodeId, from: u32, to: u32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let Some(n) = arena.get(node).filter(|n| n.kind == NodeKind::Text) else { return Some(()) };
    if !crate::rendered::collapses_white_space(arena, n.parent) {
        return Some(());
    }
    let data = &n.data;
    let space = |c: u16| c == 0x20 || c == 0xA0;
    let (mut i, mut end) = ((from as usize).min(data.len()), (to as usize).min(data.len()));
    while i > 0 && space(data[i - 1]) {
        i -= 1;
    }
    while end < data.len() && space(data[end]) {
        end += 1;
    }
    let mut runs = Vec::new();
    while i < end {
        if !space(data[i]) {
            i += 1;
            continue;
        }
        let a = i;
        while i < end && space(data[i]) {
            i += 1;
        }
        let count = i - a;
        let starts = a == 0 && line_edge(arena, node, false) != Edge::Content;
        let ends = i == data.len() && line_edge(arena, node, true) != Edge::Content;
        let units: Vec<u16> = (0..count)
            .map(|k| if count == 1 && !starts && !ends { 0x20 } else if (k == count - 1 && ends) || k % 2 == 0 { 0xA0 } else { 0x20 })
            .collect();
        if units[..] != data[a..i] {
            runs.push((a, units));
        }
    }
    if runs.is_empty() {
        return Some(());
    }
    let object = crate::dom::node_value(scope, Some(node));
    if crate::dom::factory_threw(scope) {
        return None;
    }
    for (at, units) in runs {
        let string = v8::String::new_from_two_byte(scope, &units, v8::NewStringType::Normal)?;
        crate::character_data::replace_data(scope, caller, node, object, at, units.len(), string).ok()?;
    }
    Some(())
}

// The document object `near`'s node document is — what a node the engine makes beside it is in.
pub(crate) fn document_of<'s>(scope: &mut v8::PinScope<'s, '_>, near: NodeId) -> Option<v8::Local<'s, v8::Object>> {
    let handle = crate::dom::dom(scope).arena.get(near).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
    // SAFETY: the node's handle lives while its node is in the arena, which this reads before anything allocates.
    handle.and_then(|h| unsafe { &*h }.document(scope))
}
// A node the engine makes of `data`, in `near`'s node document, by realm `caller`'s code — and what holds its handle
// until a tree does.
pub(crate) fn make(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, near: NodeId, data: NodeData) -> (NodeId, v8::cppgc::Persistent<crate::node_handle::NodeHandle>) {
    let doc = document_of(scope, near);
    let id = realm(scope, cid).create(data, None);
    (id, crate::node_handle::bare(scope, id, doc, caller))
}
// …an HTML element named `name`, …
pub(crate) fn make_element(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, near: NodeId, name: &str) -> (NodeId, v8::cppgc::Persistent<crate::node_handle::NodeHandle>) {
    let data = NodeData { local_name: web_atoms::LocalName::from(name), ns: web_atoms::ns!(html), ..NodeData::of_kind(NodeKind::Element, Vec::new()) };
    make(scope, cid, caller, near, data)
}
// …a `<br>`.
pub(crate) fn make_br(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, near: NodeId) -> (NodeId, v8::cppgc::Persistent<crate::node_handle::NodeHandle>) {
    make_element(scope, cid, caller, near, "br")
}
