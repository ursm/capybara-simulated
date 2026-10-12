// Inserting in an editing host — what typing, Enter and Shift+Enter do, and execCommand's `insertText`,
// `insertLineBreak` and `insertParagraph` — the engine's: the selection's contents deleted first (editing_delete.rs
// `delete`), then at the caret text (`Edit::text`), a `<br>` (`Edit::line_break`), or the caret's block split in two
// (`Edit::paragraph`); the white space the insertion brings together rebalanced as the line shows it (editing.rs
// `rebalance_space`). Every change of children the engine's change; the bindings finish them as the op returns, run the
// cloning steps of the elements a split copied, and put the caret where it says. Every expectation is Chrome's.

use crate::cloning::BindingsSteps;
use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::editing::{inline_level, selection_host, block_of, edge, has_content, line_edge, make, make_element, rebalance_space, within, Edge};
use crate::mutation::Change;
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editInsert", edit_insert, context_id);
}

// What an insertion inserts (`editInsert`'s `kind`): text, a line break, a paragraph's break.
const TEXT: u32 = 0;
const LINE_BREAK: u32 = 1;

// __dom.editInsert(anchorNode, anchorOffset, focusNode, focusOffset, kind, text, steps) -> [caretNode, caretOffset,
// copies, (source, copy, names)…, changes…], or undefined where nothing is inserted: the insertion in the editing host
// the selection from the anchor to the focus edits (editing.rs `selection_host`: its anchor's, the focus kept to it and
// out of its non-editable islands) at the selection's range — its contents deleted first — of `text` (`TEXT`), a line break
// (`LINE_BREAK`) or a paragraph's break (any other): the place the caret goes, how many elements a split copied and each
// with its source and the names of the attributes whose cloning steps are the bindings' (cloning.rs `bindings_value`),
// and the changes of children it made (mutation.rs `changes_value`).
fn edit_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let kind = args.get(4).uint32_value(scope).unwrap_or(TEXT);
    let text = args.get(5).to_string(scope).map_or_else(Vec::new, |s| {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        units
    });
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(6)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    if kind == TEXT && text.is_empty() && (sc, so) == (ec, eo) {
        return;
    }
    let Some((host, ((sc, so), (ec, eo)))) = selection_host(&crate::dom::dom(scope).arena, (sc, so), (ec, eo)) else { return };
    let collapsed = (sc, so) == (ec, eo);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    let steps = v8::Local::new(scope, steps);
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
    let mut caret = (sc, so);
    if !collapsed {
        let took = crate::editing_delete::Took::Step;
        // (…none deleted — a range a non-editable island's edge left empty — and the insertion at its start)
        let Some(deleted) = crate::editing_delete::delete(scope, caller, steps, host, ((sc, so), (ec, eo)), took, false, false) else { return };
        if let Some((at, made)) = deleted {
            caret = at;
            edit.changes.extend(made);
        }
    }
    let caret = match kind {
        TEXT => edit.text(scope, caret, &text),
        LINE_BREAK => edit.line_break(scope, caret),
        _ => edit.paragraph(scope, caret),
    };
    let Some(caret) = caret else { return };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![crate::dom::node_value(scope, Some(caret.0))];
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.push(v8::Integer::new_from_unsigned(scope, caret.1).into());
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// Where what is inserted at a place goes: outside a link the place is at the edge of (`<a>link</a>`, typed at its end,
// is `<a>link</a>x`); at the end of the text before it, or the start of the text after it, where there is one; and
// before a `<br>` that ends its block's last line — no line follows it — rather than after it (`ab<br>`, typed at its
// end, is `abx<br>`).
fn insertion_point(arena: &RealmArena, place: (NodeId, u32)) -> (NodeId, u32) {
    let (node, offset) = out_of_link(arena, place).unwrap_or(place);
    let Some(n) = arena.get(node).filter(|n| n.kind == NodeKind::Element) else { return (node, offset) };
    let mut k = (offset as usize).min(n.children.len());
    let br = |c: NodeId| arena.get(c).is_some_and(|d| d.is_html_named("br"));
    if k.checked_sub(1).and_then(|i| n.children.get(i).copied()).is_some_and(|b| br(b) && line_edge(arena, b, true) == Edge::Block) {
        k -= 1;
    }
    let text = |c: Option<NodeId>| c.filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text));
    if let Some(t) = text(k.checked_sub(1).and_then(|i| n.children.get(i).copied())) {
        return (t, arena.get(t).map_or(0, |d| d.data.len() as u32));
    }
    if let Some(t) = text(n.children.get(k).copied()) {
        return (t, 0);
    }
    (node, k as u32)
}
// The place outside the link `(node, offset)` is at the start or the end of — the inline elements between ending or
// starting there too — before the link or after it; none where it is at no link's edge.
fn out_of_link(arena: &RealmArena, (node, offset): (NodeId, u32)) -> Option<(NodeId, u32)> {
    let n = arena.get(node)?;
    let length = if n.kind == NodeKind::Text { n.data.len() } else { n.children.len() };
    let end = offset as usize == length;
    if !end && offset != 0 {
        return None;
    }
    let mut at = node;
    loop {
        let parent = arena.parent_of(at).filter(|&p| arena.editing_host(at) != Some(at) && arena.is_element(p))?;
        if arena.get(at).is_some_and(|d| d.is_html_named("a")) {
            let k = arena.child_index(at) as u32;
            return Some((parent, if end { k + 1 } else { k }));
        }
        let edge_child = arena.get(parent).and_then(|p| if end { p.children.last() } else { p.children.first() }.copied());
        if edge_child != Some(at) || inline_level(arena, parent) != Some(true) {
            return None;
        }
        at = parent;
    }
}
// Whether `id` is a `<br>` holding an empty line open — nothing on its line before it, the block's end after it — which
// the line's first text takes the place of (`<p><b><br></b></p>`, typed into, is `<p><b>x</b></p>`; `abcd<br><br>`,
// typed into its last line, `abcd<br>x`).
fn placeholder(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.is_html_named("br")) && line_edge(arena, id, true) == Edge::Block && line_edge(arena, id, false) != Edge::Content
}
// Whether an element is a heading, whose split leaves a `<div>` after it where nothing follows the caret.
fn heading(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| ["h1", "h2", "h3", "h4", "h5", "h6"].iter().any(|t| n.is_html_named(t)))
}

// One insertion's state: the host's realm, the realm whose code inserts, the bindings' steps of a change of children,
// and the host; the changes of children it makes, the elements it copies, and what holds the nodes it makes
// until a tree does.
struct Edit<'s, 'a> {
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    host: NodeId,
    changes: &'a mut Vec<Change>,
    copies: &'a mut BindingsSteps,
    held: &'a mut Vec<v8::cppgc::Persistent<NodeHandle>>,
}

impl<'s> Edit<'s, '_> {
    fn insert(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId], before: Option<NodeId>) -> Option<()> {
        self.changes.push(crate::mutation::insert(scope, self.cid, self.caller, parent, nodes, before, self.steps)?);
        Some(())
    }
    fn remove(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<()> {
        self.changes.push(crate::mutation::remove(scope, self.cid, self.caller, node, self.steps)?);
        Some(())
    }
    // `nodes` out of where they are, into `parent` at its end.
    fn move_into(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId]) -> Option<()> {
        for &n in nodes {
            if realm(scope, self.cid).parent_of(n).is_some() {
                self.remove(scope, n)?;
            }
        }
        if !nodes.is_empty() {
            self.insert(scope, parent, nodes, None)?;
        }
        Some(())
    }
    fn element(&mut self, scope: &mut v8::PinScope<'_, '_>, near: NodeId, name: &str) -> NodeId {
        let (id, held) = make_element(scope, self.cid, self.caller, near, name);
        self.held.push(held);
        id
    }
    // A copy of `src` alone — attributes, `id` too (Chrome) — its cloning steps the bindings' to run where it has them.
    fn copy(&mut self, scope: &mut v8::PinScope<'_, '_>, src: NodeId) -> Option<NodeId> {
        let doc = crate::editing::document_of(scope, src);
        crate::cloning::clone_into(scope, self.cid, self.caller, src, None, false, doc, self.held, self.copies)
    }

    // `text` at the caret: into the text there, or a text of its own — taking the place of a placeholder `<br>` — and the
    // white space at either edge of it rebalanced (what it holds as it is: Chrome). Where the caret goes: after it.
    fn text(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32), text: &[u16]) -> Option<(NodeId, u32)> {
        let (node, offset) = insertion_point(realm(scope, self.cid), caret);
        let arena = realm(scope, self.cid);
        let (target, at) = if arena.get(node)?.kind == NodeKind::Text {
            let object = crate::dom::node_value(scope, Some(node));
            if crate::dom::factory_threw(scope) {
                return None;
            }
            let string = v8::String::new_from_two_byte(scope, text, v8::NewStringType::Normal)?;
            crate::character_data::replace_data(scope, self.caller, node, object, offset as usize, 0, string).ok()?;
            (node, offset)
        } else {
            let before = arena.get(node)?.children.get(offset as usize).copied();
            let placeholder = before.filter(|&b| placeholder(arena, b));
            let (made, held) = make(scope, self.cid, self.caller, node, NodeData::of_kind(NodeKind::Text, text.to_vec()));
            self.held.push(held);
            self.insert(scope, node, &[made], before)?;
            if let Some(br) = placeholder {
                self.remove(scope, br)?;
            }
            (made, 0)
        };
        let end = at + text.len() as u32;
        rebalance_space(scope, self.caller, target, at, at)?;
        rebalance_space(scope, self.caller, target, end, end)?;
        Some((target, end))
    }

    // A `<br>` at the caret — a second after it where it ends its block, which the line it starts is — and the white
    // space starting the line after it rebalanced (that ending the line before it collapses as it is: Chrome). Where the
    // caret goes: after it, at the start of the text that follows it.
    fn line_break(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let place = insertion_point(realm(scope, self.cid), caret);
        let (parent, before) = self.split_at(scope, place)?;
        let br = self.element(scope, parent, "br");
        self.insert(scope, parent, &[br], before)?;
        if line_edge(realm(scope, self.cid), br, true) == Edge::Block {
            let second = self.element(scope, parent, "br");
            let after = realm(scope, self.cid).sibling(br, 1);
            self.insert(scope, parent, &[second], after)?;
        }
        let after = realm(scope, self.cid).sibling(br, 1);
        self.rebalance_beside(scope, parent, after)?;
        let arena = realm(scope, self.cid);
        Some(match after.filter(|&t| arena.get(t).is_some_and(|n| n.kind == NodeKind::Text)) {
            Some(text) => (text, 0),
            None => (parent, arena.child_index(br) as u32 + 1),
        })
    }

    // The caret's block split in two at the caret — in a table's cell, a `<pre>` or an inline host a line break; in an
    // empty list item (or one whose block the caret's is), the item out of its list (`out_of_list`); in the host itself,
    // the line (`host_line`): what follows the caret in it — in the elements between, copies of them — in a copy of it
    // after it (a `<div>` after a heading nothing follows the caret in), a list item split with the block it holds
    // (`<li><p>ab</p></li>`, broken at its end, is `<li><p>ab</p></li><li><p><br></p></li>`), the inline elements the
    // caret leaves empty at the end of the first part gone where it shows anything else, and either part that shows
    // nothing held open by a `<br>`. Where the caret goes: the start of the second.
    fn paragraph(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let (cid, host) = (self.cid, self.host);
        let arena = realm(scope, cid);
        let place = insertion_point(arena, caret);
        let block = block_of(arena, place.0, host);
        let b = arena.get(block)?;
        if ["td", "th", "caption", "pre", "listing"].iter().any(|t| b.is_html_named(t)) || (block == host && inline_level(arena, host) == Some(true)) {
            return self.line_break(scope, caret);
        }
        let li = |n: NodeId| n != host && arena.get(n).is_some_and(|d| d.is_html_named("li"));
        let item = Some(block).filter(|&n| li(n)).or_else(|| arena.parent_of(block).filter(|&p| li(p) && block != host));
        if let Some(item) = item.filter(|&i| !has_content(arena, i) && arena.parent_of(i).is_some_and(|list| list != host && within(arena, host, list))) {
            return self.out_of_list(scope, item);
        }
        let top = item.unwrap_or(block);
        let (parent, before) = self.split_at(scope, place)?;
        if top == host {
            return self.host_line(scope, parent, before);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, top)?;
        let arena = realm(scope, cid);
        let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
        let copy = if heading(arena, top) && !nodes.iter().any(|&n| has_content(arena, n)) { self.element(scope, top, "div") } else { self.copy(scope, top)? };
        self.move_into(scope, copy, &nodes)?;
        let arena = realm(scope, cid);
        let (outer, after) = (arena.parent_of(top)?, arena.sibling(top, 1));
        self.insert(scope, outer, &[copy], after)?;
        self.drop_emptied_edge(scope, top, false)?;
        self.drop_emptied_edge(scope, copy, true)?;
        self.hold_open(scope, top, false)?;
        let caret = self.hold_open(scope, copy, true)?;
        self.rebalance_leaf(scope, top, false)?;
        self.rebalance_leaf(scope, copy, true)?;
        Some(caret)
    }
    // The line the caret is on in the host itself split: at its start, more of it after the caret, an empty `<div>` before
    // it, the caret where it was (`ab`, broken at its start, is `<div><br></div>ab`); anywhere else, what follows the caret
    // up to the host's next block — its `<br>`s and the lines after them too — in a `<div>` after what precedes it
    // (`a<div>b<br>cd</div>`), and a `<br>` before that where nothing does on its line (an empty host, broken, is
    // `<br><div><br></div>`).
    fn host_line(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, before: Option<NodeId>) -> Option<(NodeId, u32)> {
        let (cid, host) = (self.cid, self.host);
        let arena = realm(scope, cid);
        if edge(arena, parent, before, false) != Edge::Content && edge(arena, parent, before, true) == Edge::Content {
            let mut top = before;
            let mut at = parent;
            while at != host {
                top = Some(at);
                at = arena.parent_of(at)?;
            }
            let caret = match before {
                Some(b) if arena.get(b).is_some_and(|n| n.kind == NodeKind::Text) => (b, 0),
                Some(b) => (parent, arena.child_index(b) as u32),
                None => (parent, arena.get(parent)?.children.len() as u32),
            };
            let div = self.element(scope, host, "div");
            let br = self.element(scope, host, "br");
            self.insert(scope, div, &[br], None)?;
            self.insert(scope, host, &[div], top)?;
            return Some(caret);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, host)?;
        let arena = realm(scope, cid);
        let block = |n: NodeId| arena.is_element(n) && inline_level(arena, n) == Some(false);
        let line: Vec<NodeId> = std::iter::successors(before, |&n| arena.sibling(n, 1)).take_while(|&n| !block(n)).collect();
        let next = line.last().map_or(before, |&n| arena.sibling(n, 1));
        let nodes: Vec<NodeId> = moved.into_iter().chain(line).collect();
        let div = self.element(scope, host, "div");
        self.move_into(scope, div, &nodes)?;
        self.insert(scope, host, &[div], next)?;
        if edge(realm(scope, cid), host, Some(div), false) != Edge::Content {
            let br = self.element(scope, host, "br");
            self.insert(scope, host, &[br], Some(div))?;
        }
        let caret = self.hold_open(scope, div, true)?;
        self.rebalance_beside(scope, host, Some(div))?;
        self.rebalance_leaf(scope, div, true)?;
        Some(caret)
    }
    // An empty list item out of its list: in a list that ends another's item, a new item of that list after it; else a
    // `<div>` after the list (`<li>a<ul><li></li></ul>b</li>` is `<li>a<div><br></div>b</li>`); the items after this one in
    // a copy of the list after that, the list removed where that empties it. Where the caret goes: in the new block,
    // before its `<br>`.
    fn out_of_list(&mut self, scope: &mut v8::PinScope<'_, '_>, item: NodeId) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let list = arena.parent_of(item)?;
        let outer = arena.parent_of(list)?;
        let ends = std::iter::successors(arena.sibling(list, 1), |&n| arena.sibling(n, 1)).all(|n| !has_content(arena, n));
        let nested = outer != self.host && ends && arena.get(outer).is_some_and(|n| n.is_html_named("li"));
        let following: Vec<NodeId> = std::iter::successors(arena.sibling(item, 1), |&n| arena.sibling(n, 1)).collect();
        self.remove(scope, item)?;
        let (block, into, after) = if nested {
            let arena = realm(scope, self.cid);
            let (into, after) = (arena.parent_of(outer)?, arena.sibling(outer, 1));
            (self.element(scope, outer, "li"), into, after)
        } else {
            (self.element(scope, list, "div"), outer, realm(scope, self.cid).sibling(list, 1))
        };
        let br = self.element(scope, block, "br");
        self.insert(scope, block, &[br], None)?;
        self.insert(scope, into, &[block], after)?;
        if !following.is_empty() {
            let rest = self.copy(scope, list)?;
            self.move_into(scope, rest, &following)?;
            let after = realm(scope, self.cid).sibling(block, 1);
            self.insert(scope, into, &[rest], after)?;
        }
        if realm(scope, self.cid).get(list).is_some_and(|n| n.children.is_empty()) {
            self.remove(scope, list)?;
        }
        Some((block, 0))
    }

    // A place made one between children: a text there split at it (character_data.rs `split_text`), where it is inside
    // one. The parent, and the child after the place.
    fn split_at(&mut self, scope: &mut v8::PinScope<'_, '_>, (node, offset): (NodeId, u32)) -> Option<(NodeId, Option<NodeId>)> {
        let arena = realm(scope, self.cid);
        let n = arena.get(node)?;
        if n.kind != NodeKind::Text {
            return Some((node, n.children.get(offset as usize).copied()));
        }
        let parent = n.parent?;
        if offset == 0 {
            return Some((parent, Some(node)));
        }
        if offset as usize >= n.data.len() {
            return Some((parent, arena.sibling(node, 1)));
        }
        let object = crate::dom::node_value(scope, Some(node));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let (new, made) = crate::character_data::split_text(scope, self.caller, node, object, offset as usize, self.steps)?;
        self.changes.extend(made);
        Some((parent, Some(new)))
    }
    // The inline elements from `parent` up to — not — `top` split at the place before `before`: what follows the place in
    // each moved into a copy of it, the copy of the one below first. The child of `top` the place is before then, and the
    // copy of the one it split, holding what followed the place in it.
    fn split_inlines(&mut self, scope: &mut v8::PinScope<'_, '_>, mut parent: NodeId, mut before: Option<NodeId>, top: NodeId) -> Option<(Option<NodeId>, Option<NodeId>)> {
        let mut moved = None;
        while parent != top {
            let arena = realm(scope, self.cid);
            let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
            let copy = self.copy(scope, parent)?;
            self.move_into(scope, copy, &nodes)?;
            let arena = realm(scope, self.cid);
            before = arena.sibling(parent, 1);
            parent = arena.parent_of(parent)?;
            moved = Some(copy);
        }
        Some((moved, before))
    }
    // The inline element at the end of `block` a split left empty — the caret was at its start — or at its start (`first`)
    // — the caret was at its end — gone, where the block shows anything else (`<p>ab<b>|cd</b></p>`, broken, is
    // `<p>ab</p><p><b>cd</b></p>`; `<p><b>ab|</b>cd</p>` `<p><b>ab</b></p><p>cd</p>`).
    fn drop_emptied_edge(&mut self, scope: &mut v8::PinScope<'_, '_>, block: NodeId, first: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        if !has_content(arena, block) {
            return Some(());
        }
        let last = arena.get(block).and_then(|n| if first { n.children.first() } else { n.children.last() }.copied());
        let emptied = last.filter(|&c| {
            arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name))
                && inline_level(arena, c) == Some(true)
                && !has_content(arena, c)
        });
        match emptied {
            Some(c) => self.remove(scope, c),
            None => Some(()),
        }
    }
    // `block`, where it shows nothing, held open by a `<br>` in its innermost element on one side — its first (`first`)
    // or last children's, none a non-editable island, an atom or a link — and where the caret goes in it on that side:
    // before that `<br>`, or at the start of its first text.
    fn hold_open(&mut self, scope: &mut v8::PinScope<'_, '_>, block: NodeId, first: bool) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let side = |n: NodeId| arena.get(n).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied());
        let mut at = block;
        let into = |c: NodeId| {
            arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name) && !d.is_html_named("a"))
                && arena.editing_host(c).is_some()
                && !crate::rendered::is_atomic_inline(arena, c)
        };
        while let Some(c) = side(at).filter(|&c| into(c)) {
            at = c;
        }
        if has_content(arena, block) {
            return Some(match side(at).filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text)) {
                Some(text) if first => (text, 0),
                _ => (at, 0),
            });
        }
        if !arena.get(at)?.children.iter().any(|&c| arena.get(c).is_some_and(|d| d.is_html_named("br"))) {
            let br = self.element(scope, at, "br");
            self.insert(scope, at, &[br], None)?;
        }
        Some((at, 0))
    }
    // The white space at the start (`first`) or the end of what `root` holds — a line a split began or ended — rebalanced.
    fn rebalance_leaf(&mut self, scope: &mut v8::PinScope<'_, '_>, root: NodeId, first: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        let mut at = root;
        while let Some(c) = arena.get(at).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied()) {
            at = c;
        }
        let Some(len) = arena.get(at).filter(|d| d.kind == NodeKind::Text).map(|d| d.data.len() as u32) else { return Some(()) };
        let offset = if first { 0 } else { len };
        rebalance_space(scope, self.caller, at, offset, offset)
    }
    // The white space of the texts either side of the place before `child` in `parent`.
    fn rebalance_beside(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, child: Option<NodeId>) -> Option<()> {
        let arena = realm(scope, self.cid);
        let before = child.map_or_else(|| arena.get(parent).and_then(|n| n.children.last().copied()), |c| arena.sibling(c, -1));
        let text = |n: Option<NodeId>| n.filter(|&n| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text));
        let sides = [text(before).map(|t| (t, arena.get(t).map_or(0, |d| d.data.len() as u32))), text(child).map(|t| (t, 0))];
        for (t, at) in sides.into_iter().flatten() {
            rebalance_space(scope, self.caller, t, at, at)?;
        }
        Some(())
    }
}
